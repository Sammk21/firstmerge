import path from "node:path";
import fs from "node:fs";
// Type-only import (erased at build) so we keep types without the bundler
// trying to resolve/bundle the node:sqlite builtin.
import type * as SqliteNS from "node:sqlite";

// ---------------------------------------------------------------------------
// Data layer. Uses Node's built-in SQLite (node:sqlite) — zero native deps,
// nothing to compile, runs anywhere Node 22.5+ runs. The rest of the app only
// talks to the functions exported here, so swapping to Postgres later means
// rewriting this one file, nothing else.
//
// We load node:sqlite via process.getBuiltinModule() rather than import/require
// so bundlers (Turbopack/webpack) don't try to externalize it — that path threw
// "require is not defined" in the ESM dev runtime.
// ---------------------------------------------------------------------------

const sqlite = (
  process as unknown as { getBuiltinModule(id: string): typeof SqliteNS }
).getBuiltinModule("node:sqlite");

const DATA_DIR = path.join(process.cwd(), ".data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new sqlite.DatabaseSync(path.join(DATA_DIR, "firstmerge.db"));
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS repos (
    id                  INTEGER PRIMARY KEY,
    full_name           TEXT UNIQUE NOT NULL,
    stars               INTEGER DEFAULT 0,
    language            TEXT,
    last_commit_at      TEXT,
    pr_merge_rate_90d   REAL,        -- 0..1, share of external PRs merged
    median_response_hrs REAL,        -- maintainer responsiveness
    updated_at          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS issues (
    id            INTEGER PRIMARY KEY,         -- github issue id
    repo_id       INTEGER NOT NULL,
    repo_full     TEXT NOT NULL,
    number        INTEGER NOT NULL,
    title         TEXT NOT NULL,
    url           TEXT NOT NULL,
    language      TEXT,
    labels        TEXT,                        -- JSON array of strings
    comments      INTEGER DEFAULT 0,
    created_at    TEXT,
    is_assigned   INTEGER DEFAULT 0,           -- 0/1
    has_linked_pr INTEGER DEFAULT 0,           -- 0/1
    merge_score   INTEGER DEFAULT 0,           -- 0..100
    score_band    TEXT DEFAULT 'yellow',       -- green | yellow | red
    state         TEXT DEFAULT 'open',         -- open | closed (closed = done, hidden)
    last_seen_at  TEXT,                        -- last time search returned it
    last_checked_at TEXT,                      -- last time we confirmed its state
    fetched_at    TEXT NOT NULL,
    FOREIGN KEY (repo_id) REFERENCES repos(id)
  );

  CREATE INDEX IF NOT EXISTS idx_issues_band     ON issues(score_band);
  CREATE INDEX IF NOT EXISTS idx_issues_language ON issues(language);
  CREATE INDEX IF NOT EXISTS idx_issues_score    ON issues(merge_score DESC);
`);

// Lightweight migration so existing databases pick up the new columns. This
// MUST run before any index/query that references the new columns.
{
  const cols = new Set(
    (db.prepare("PRAGMA table_info(issues)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!cols.has("state")) db.exec("ALTER TABLE issues ADD COLUMN state TEXT DEFAULT 'open'");
  if (!cols.has("last_seen_at")) db.exec("ALTER TABLE issues ADD COLUMN last_seen_at TEXT");
  if (!cols.has("last_checked_at")) db.exec("ALTER TABLE issues ADD COLUMN last_checked_at TEXT");
}

// Indexes on the (possibly just-added) freshness columns — safe now.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_issues_state   ON issues(state);
  CREATE INDEX IF NOT EXISTS idx_issues_checked ON issues(last_checked_at);
`);

// ----- types ---------------------------------------------------------------

export interface RepoRow {
  id: number;
  full_name: string;
  stars: number;
  language: string | null;
  last_commit_at: string | null;
  pr_merge_rate_90d: number | null;
  median_response_hrs: number | null;
  updated_at: string;
}

export interface IssueRow {
  id: number;
  repo_id: number;
  repo_full: string;
  number: number;
  title: string;
  url: string;
  language: string | null;
  labels: string; // JSON
  comments: number;
  created_at: string | null;
  is_assigned: number;
  has_linked_pr: number;
  merge_score: number;
  score_band: "green" | "yellow" | "red";
  state: "open" | "closed";
  last_seen_at: string | null;
  last_checked_at: string | null;
  fetched_at: string;
  stars?: number; // joined from repos for display + popularity sort
}

// ----- writes --------------------------------------------------------------

const upsertRepoStmt = db.prepare(`
  INSERT INTO repos (id, full_name, stars, language, last_commit_at,
                     pr_merge_rate_90d, median_response_hrs, updated_at)
  VALUES (@id, @full_name, @stars, @language, @last_commit_at,
          @pr_merge_rate_90d, @median_response_hrs, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    stars               = excluded.stars,
    language            = excluded.language,
    last_commit_at      = excluded.last_commit_at,
    pr_merge_rate_90d   = excluded.pr_merge_rate_90d,
    median_response_hrs = excluded.median_response_hrs,
    updated_at          = excluded.updated_at
`);

export function upsertRepo(r: Omit<RepoRow, "updated_at">) {
  upsertRepoStmt.run({ ...r, updated_at: new Date().toISOString() });
}

/**
 * Cross-run repo cache. Returns the stored repo row only if we refreshed it
 * within maxAgeMs — so repeated ingests don't refetch the same repo from GitHub
 * (works even without Redis, since this is persisted to disk).
 */
export function getRepoIfFresh(fullName: string, maxAgeMs: number): RepoRow | null {
  const row = db.prepare(`SELECT * FROM repos WHERE full_name = @full`).get({ full: fullName }) as
    | RepoRow
    | undefined;
  if (!row) return null;
  if (Date.now() - new Date(row.updated_at).getTime() > maxAgeMs) return null;
  return row;
}

const upsertIssueStmt = db.prepare(`
  INSERT INTO issues (id, repo_id, repo_full, number, title, url, language,
                      labels, comments, created_at, is_assigned, has_linked_pr,
                      merge_score, score_band, state, last_seen_at, last_checked_at, fetched_at)
  VALUES (@id, @repo_id, @repo_full, @number, @title, @url, @language,
          @labels, @comments, @created_at, @is_assigned, @has_linked_pr,
          @merge_score, @score_band, 'open', @now, @now, @now)
  ON CONFLICT(id) DO UPDATE SET
    title           = excluded.title,
    labels          = excluded.labels,
    comments        = excluded.comments,
    is_assigned     = excluded.is_assigned,
    has_linked_pr   = excluded.has_linked_pr,
    merge_score     = excluded.merge_score,
    score_band      = excluded.score_band,
    state           = 'open',            -- search only returns open issues
    last_seen_at    = excluded.last_seen_at,
    last_checked_at = excluded.last_checked_at,
    fetched_at      = excluded.fetched_at
`);

export function upsertIssue(
  i: Omit<IssueRow, "fetched_at" | "state" | "last_seen_at" | "last_checked_at">
) {
  // Freshly returned by a state:open search, so it's verified open right now.
  upsertIssueStmt.run({ ...i, now: new Date().toISOString() });
}

// ----- freshness / revalidation --------------------------------------------

/** Open issues we haven't confirmed recently — candidates to re-check. */
export function staleOpenIssues(checkedBeforeIso: string, limit: number): IssueRow[] {
  return db
    .prepare(
      `SELECT * FROM issues
       WHERE state = 'open' AND (last_checked_at IS NULL OR last_checked_at < @before)
       ORDER BY last_checked_at ASC
       LIMIT @limit`
    )
    .all({ before: checkedBeforeIso, limit }) as IssueRow[];
}

const setStateStmt = db.prepare(
  `UPDATE issues SET state = @state, last_checked_at = @now WHERE id = @id`
);

/** Record the verified state of an issue (and stamp the check time). */
export function setIssueState(id: number, state: "open" | "closed") {
  setStateStmt.run({ id, state, now: new Date().toISOString() });
}

// ----- reads ---------------------------------------------------------------

export type IssueSort = "score" | "stars_desc" | "stars_asc" | "newest";

export interface IssueQuery {
  language?: string;
  band?: "green" | "yellow" | "red";
  unclaimedOnly?: boolean;
  minStars?: number;
  sort?: IssueSort;
  limit?: number;
  /** Include closed/merged issues too. Off by default — we normally only show open. */
  includeClosed?: boolean;
}

const ORDER_BY: Record<IssueSort, string> = {
  score: "i.merge_score DESC, i.created_at DESC",
  stars_desc: "r.stars DESC, i.merge_score DESC",
  stars_asc: "r.stars ASC, i.merge_score DESC",
  newest: "i.created_at DESC",
};

export function queryIssues(q: IssueQuery): IssueRow[] {
  // By default only show issues we believe are still open; closed/merged ones
  // are hidden the moment revalidation catches them. The "Show closed" filter
  // opts back into seeing everything.
  const where: string[] = [];
  if (!q.includeClosed) where.push("i.state = 'open'");
  const params: Record<string, unknown> = {};

  if (q.language) { where.push("i.language = @language"); params.language = q.language; }
  if (q.band) { where.push("i.score_band = @band"); params.band = q.band; }
  if (q.unclaimedOnly) { where.push("i.is_assigned = 0 AND i.has_linked_pr = 0"); }
  if (q.minStars) { where.push("r.stars >= @minStars"); params.minStars = q.minStars; }

  const orderBy = ORDER_BY[q.sort ?? "score"];
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT i.*, r.stars AS stars FROM issues i
    JOIN repos r ON r.id = i.repo_id
    ${whereSql}
    ORDER BY ${orderBy}
    LIMIT @limit
  `;
  params.limit = q.limit ?? 60;
  const rows = db.prepare(sql).all(params) as IssueRow[];
  // better-sqlite3 rows don't have Object.prototype, which Next's RSC
  // serializer rejects when these cross into a Client Component. Spread each
  // into a plain object literal so they're safe to pass to the client.
  return rows.map((r) => ({ ...r }));
}

export function languages(): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT language FROM issues WHERE language IS NOT NULL AND state = 'open' ORDER BY language`)
    .all() as { language: string }[];
  return rows.map((r) => r.language);
}

export function stats() {
  const row = db
    .prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN score_band='green'  THEN 1 ELSE 0 END) AS green,
      SUM(CASE WHEN is_assigned=0 AND has_linked_pr=0 THEN 1 ELSE 0 END) AS unclaimed
    FROM issues WHERE state = 'open'`)
    .get() as { total: number; green: number; unclaimed: number };
  return row;
}

// ----- analytics (dashboard) -----------------------------------------------

export interface Analytics {
  openTotal: number;
  closedTotal: number;
  greenTotal: number;
  yellowTotal: number;
  redTotal: number;
  unclaimedTotal: number;
  reposTracked: number;
  lastIngestAt: string | null;
  verifiedLastHour: number;
  staleOver6h: number;
  byLanguage: { language: string; count: number }[];
  topRepos: { repo_full: string; count: number; stars: number }[];
  freshestVerifiedAt: string | null;
}

export function analytics(): Analytics {
  const base = db
    .prepare(
      `SELECT
        SUM(CASE WHEN state='open'   THEN 1 ELSE 0 END) AS openTotal,
        SUM(CASE WHEN state='closed' THEN 1 ELSE 0 END) AS closedTotal,
        SUM(CASE WHEN state='open' AND score_band='green'  THEN 1 ELSE 0 END) AS greenTotal,
        SUM(CASE WHEN state='open' AND score_band='yellow' THEN 1 ELSE 0 END) AS yellowTotal,
        SUM(CASE WHEN state='open' AND score_band='red'    THEN 1 ELSE 0 END) AS redTotal,
        SUM(CASE WHEN state='open' AND is_assigned=0 AND has_linked_pr=0 THEN 1 ELSE 0 END) AS unclaimedTotal,
        MAX(fetched_at) AS lastIngestAt,
        MAX(last_checked_at) AS freshestVerifiedAt
      FROM issues`
    )
    .get() as Record<string, number | string | null>;

  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const sixHrAgo = new Date(Date.now() - 6 * 3600 * 1000).toISOString();

  const verifiedLastHour = (
    db.prepare(`SELECT COUNT(*) AS n FROM issues WHERE last_checked_at >= @t`).get({ t: hourAgo }) as { n: number }
  ).n;
  const staleOver6h = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM issues WHERE state='open' AND (last_checked_at IS NULL OR last_checked_at < @t)`)
      .get({ t: sixHrAgo }) as { n: number }
  ).n;
  const reposTracked = (db.prepare(`SELECT COUNT(*) AS n FROM repos`).get() as { n: number }).n;

  const byLanguage = db
    .prepare(
      `SELECT COALESCE(language,'unknown') AS language, COUNT(*) AS count
       FROM issues WHERE state='open' GROUP BY language ORDER BY count DESC`
    )
    .all() as { language: string; count: number }[];

  const topRepos = db
    .prepare(
      `SELECT i.repo_full AS repo_full, COUNT(*) AS count, COALESCE(r.stars,0) AS stars
       FROM issues i LEFT JOIN repos r ON r.id = i.repo_id
       WHERE i.state='open'
       GROUP BY i.repo_full ORDER BY count DESC, stars DESC LIMIT 10`
    )
    .all() as { repo_full: string; count: number; stars: number }[];

  return {
    openTotal: Number(base.openTotal ?? 0),
    closedTotal: Number(base.closedTotal ?? 0),
    greenTotal: Number(base.greenTotal ?? 0),
    yellowTotal: Number(base.yellowTotal ?? 0),
    redTotal: Number(base.redTotal ?? 0),
    unclaimedTotal: Number(base.unclaimedTotal ?? 0),
    reposTracked,
    lastIngestAt: (base.lastIngestAt as string) ?? null,
    verifiedLastHour,
    staleOver6h,
    byLanguage,
    topRepos,
    freshestVerifiedAt: (base.freshestVerifiedAt as string) ?? null,
  };
}

export default db;
