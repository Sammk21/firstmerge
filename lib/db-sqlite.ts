import path from "node:path";
import fs from "node:fs";
// Type-only import (erased at build) so we keep types without the bundler
// trying to resolve/bundle the node:sqlite builtin.
import type * as SqliteNS from "node:sqlite";

import {
  ORDER_BY,
  likePattern,
  type RepoRow,
  type IssueRow,
  type IssueQuery,
  type Analytics,
  type RepoInput,
  type IssueInput,
} from "./db-types";

// ---------------------------------------------------------------------------
// SQLite backend (local dev). Uses Node's built-in node:sqlite — zero native
// deps, runs anywhere Node 22.5+ runs. NODE RUNTIME ONLY: never import this from
// an edge module. Selected by the facade (lib/db.ts) when DATABASE_URL is unset.
//
// The functions here are async (return Promises) only to match the Postgres
// backend's signatures — the underlying node:sqlite calls are synchronous.
//
// We load node:sqlite via process.getBuiltinModule() rather than import/require
// so bundlers (Turbopack/webpack) don't try to externalize it.
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
    pr_merge_rate_90d   REAL,
    median_response_hrs REAL,
    updated_at          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS issues (
    id            INTEGER PRIMARY KEY,
    repo_id       INTEGER NOT NULL,
    repo_full     TEXT NOT NULL,
    number        INTEGER NOT NULL,
    title         TEXT NOT NULL,
    url           TEXT NOT NULL,
    language      TEXT,
    labels        TEXT,
    comments      INTEGER DEFAULT 0,
    created_at    TEXT,
    is_assigned   INTEGER DEFAULT 0,
    has_linked_pr INTEGER DEFAULT 0,
    linked_pr_count INTEGER DEFAULT 0,
    merge_score   INTEGER DEFAULT 0,
    score_band    TEXT DEFAULT 'yellow',
    state         TEXT DEFAULT 'open',
    last_seen_at  TEXT,
    last_checked_at TEXT,
    fetched_at    TEXT NOT NULL,
    FOREIGN KEY (repo_id) REFERENCES repos(id)
  );

  CREATE INDEX IF NOT EXISTS idx_issues_band     ON issues(score_band);
  CREATE INDEX IF NOT EXISTS idx_issues_language ON issues(language);
  CREATE INDEX IF NOT EXISTS idx_issues_score    ON issues(merge_score DESC);
`);

// Lightweight migration so existing databases pick up newer columns.
{
  const cols = new Set(
    (db.prepare("PRAGMA table_info(issues)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!cols.has("state")) db.exec("ALTER TABLE issues ADD COLUMN state TEXT DEFAULT 'open'");
  if (!cols.has("last_seen_at")) db.exec("ALTER TABLE issues ADD COLUMN last_seen_at TEXT");
  if (!cols.has("last_checked_at")) db.exec("ALTER TABLE issues ADD COLUMN last_checked_at TEXT");
  if (!cols.has("linked_pr_count")) db.exec("ALTER TABLE issues ADD COLUMN linked_pr_count INTEGER DEFAULT 0");
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_issues_state   ON issues(state);
  CREATE INDEX IF NOT EXISTS idx_issues_checked ON issues(last_checked_at);
  -- covers the default read path: WHERE state='open' ORDER BY merge_score DESC
  CREATE INDEX IF NOT EXISTS idx_issues_open_score ON issues(state, merge_score DESC);
`);

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

export async function upsertRepo(r: RepoInput): Promise<void> {
  upsertRepoStmt.run({ ...r, updated_at: new Date().toISOString() });
}

export async function getRepoIfFresh(fullName: string, maxAgeMs: number): Promise<RepoRow | null> {
  const row = db.prepare(`SELECT * FROM repos WHERE full_name = @full`).get({ full: fullName }) as
    | RepoRow
    | undefined;
  if (!row) return null;
  if (Date.now() - new Date(row.updated_at).getTime() > maxAgeMs) return null;
  return { ...row };
}

const upsertIssueStmt = db.prepare(`
  INSERT INTO issues (id, repo_id, repo_full, number, title, url, language,
                      labels, comments, created_at, is_assigned, has_linked_pr,
                      linked_pr_count, merge_score, score_band, state, last_seen_at,
                      last_checked_at, fetched_at)
  VALUES (@id, @repo_id, @repo_full, @number, @title, @url, @language,
          @labels, @comments, @created_at, @is_assigned, @has_linked_pr,
          @linked_pr_count, @merge_score, @score_band, 'open', @now, @now, @now)
  ON CONFLICT(id) DO UPDATE SET
    title           = excluded.title,
    labels          = excluded.labels,
    comments        = excluded.comments,
    is_assigned     = excluded.is_assigned,
    has_linked_pr   = excluded.has_linked_pr,
    linked_pr_count = excluded.linked_pr_count,
    merge_score     = excluded.merge_score,
    score_band      = excluded.score_band,
    state           = 'open',
    last_seen_at    = excluded.last_seen_at,
    last_checked_at = excluded.last_checked_at,
    fetched_at      = excluded.fetched_at
`);

export async function upsertIssue(i: IssueInput): Promise<void> {
  upsertIssueStmt.run({ ...i, now: new Date().toISOString() });
}

// ----- freshness / revalidation --------------------------------------------

export async function staleOpenIssues(checkedBeforeIso: string, limit: number): Promise<IssueRow[]> {
  const rows = db
    .prepare(
      `SELECT * FROM issues
       WHERE state = 'open' AND (last_checked_at IS NULL OR last_checked_at < @before)
       ORDER BY last_checked_at ASC
       LIMIT @limit`
    )
    .all({ before: checkedBeforeIso, limit }) as IssueRow[];
  return rows.map((r) => ({ ...r }));
}

const setStateStmt = db.prepare(
  `UPDATE issues SET state = @state, last_checked_at = @now WHERE id = @id`
);

export async function setIssueState(id: number, state: "open" | "closed"): Promise<void> {
  setStateStmt.run({ id, state, now: new Date().toISOString() });
}

// ----- reads ---------------------------------------------------------------

export async function queryIssues(q: IssueQuery): Promise<IssueRow[]> {
  const where: string[] = ["i.state = 'open'"];
  const params: Record<string, unknown> = {};

  if (q.language) { where.push("i.language = @language"); params.language = q.language; }
  if (q.band) { where.push("i.score_band = @band"); params.band = q.band; }
  if (q.unclaimedOnly) { where.push("i.is_assigned = 0 AND i.has_linked_pr = 0"); }
  if (q.minStars) { where.push("r.stars >= @minStars"); params.minStars = q.minStars; }
  if (q.search) { where.push("i.title LIKE @search ESCAPE '\\'"); params.search = likePattern(q.search); }

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
  // node:sqlite rows don't have Object.prototype, which Next's RSC serializer
  // rejects across the Client Component boundary — spread to plain objects.
  return rows.map((r) => ({ ...r }));
}

export async function languages(): Promise<string[]> {
  const rows = db
    .prepare(`SELECT DISTINCT language FROM issues WHERE language IS NOT NULL AND state = 'open' ORDER BY language`)
    .all() as { language: string }[];
  return rows.map((r) => r.language);
}

export async function stats(): Promise<{ total: number; green: number; unclaimed: number }> {
  const row = db
    .prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN score_band='green'  THEN 1 ELSE 0 END) AS green,
      SUM(CASE WHEN is_assigned=0 AND has_linked_pr=0 THEN 1 ELSE 0 END) AS unclaimed
    FROM issues WHERE state = 'open'`)
    .get() as { total: number; green: number; unclaimed: number };
  return {
    total: Number(row.total ?? 0),
    green: Number(row.green ?? 0),
    unclaimed: Number(row.unclaimed ?? 0),
  };
}

// ----- analytics (dashboard) -----------------------------------------------

export async function analytics(): Promise<Analytics> {
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

  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const avgScore = Number(
    (db.prepare(`SELECT AVG(merge_score) AS a FROM issues WHERE state='open'`).get() as { a: number | null }).a ?? 0
  );
  const openedLast7d = (
    db.prepare(`SELECT COUNT(*) AS n FROM issues WHERE state='open' AND created_at >= @t`).get({ t: weekAgo }) as { n: number }
  ).n;
  const tierRow = db
    .prepare(
      `SELECT
        SUM(CASE WHEN r.stars < 100 THEN 1 ELSE 0 END) AS t0,
        SUM(CASE WHEN r.stars >= 100 AND r.stars < 1000 THEN 1 ELSE 0 END) AS t1,
        SUM(CASE WHEN r.stars >= 1000 AND r.stars < 10000 THEN 1 ELSE 0 END) AS t2,
        SUM(CASE WHEN r.stars >= 10000 THEN 1 ELSE 0 END) AS t3
       FROM issues i JOIN repos r ON r.id = i.repo_id WHERE i.state='open'`
    )
    .get() as Record<string, number | null>;
  const starTiers = [
    { tier: "<100★", count: Number(tierRow.t0 ?? 0) },
    { tier: "100–1k★", count: Number(tierRow.t1 ?? 0) },
    { tier: "1k–10k★", count: Number(tierRow.t2 ?? 0) },
    { tier: "10k+★", count: Number(tierRow.t3 ?? 0) },
  ];

  const byLanguage = (
    db
      .prepare(
        `SELECT COALESCE(language,'unknown') AS language, COUNT(*) AS count
         FROM issues WHERE state='open' GROUP BY language ORDER BY count DESC`
      )
      .all() as { language: string; count: number }[]
  ).map((r) => ({ language: r.language, count: Number(r.count) }));

  const topRepos = (
    db
      .prepare(
        `SELECT i.repo_full AS repo_full, COUNT(*) AS count, COALESCE(r.stars,0) AS stars
         FROM issues i LEFT JOIN repos r ON r.id = i.repo_id
         WHERE i.state='open'
         GROUP BY i.repo_full ORDER BY count DESC, stars DESC LIMIT 10`
      )
      .all() as { repo_full: string; count: number; stars: number }[]
  ).map((r) => ({ repo_full: r.repo_full, count: Number(r.count), stars: Number(r.stars) }));

  return {
    openTotal: Number(base.openTotal ?? 0),
    closedTotal: Number(base.closedTotal ?? 0),
    greenTotal: Number(base.greenTotal ?? 0),
    yellowTotal: Number(base.yellowTotal ?? 0),
    redTotal: Number(base.redTotal ?? 0),
    unclaimedTotal: Number(base.unclaimedTotal ?? 0),
    reposTracked: Number(reposTracked),
    lastIngestAt: (base.lastIngestAt as string) ?? null,
    verifiedLastHour: Number(verifiedLastHour),
    staleOver6h: Number(staleOver6h),
    byLanguage,
    topRepos,
    freshestVerifiedAt: (base.freshestVerifiedAt as string) ?? null,
    avgScore: Math.round(avgScore),
    openedLast7d: Number(openedLast7d),
    starTiers,
  };
}
