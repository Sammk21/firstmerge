import { neon } from "@neondatabase/serverless";

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
// Postgres backend (production / Neon). Uses @neondatabase/serverless's HTTP
// driver, which works in Vercel's serverless and edge runtimes (a normal pg
// socket pool does not). Selected by the facade (lib/db.ts) when DATABASE_URL
// is set.
//
// Rows are normalized back to the existing IssueRow shape (BOOLEAN -> 0/1,
// BIGINT/numeric -> number) so components and scoring need no changes.
// ---------------------------------------------------------------------------

const sql = neon(process.env.DATABASE_URL!);

// `sql.query(text, params)` runs a parameterized query and returns the rows.
function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return sql.query(text, params) as Promise<T[]>;
}

// ----- schema (idempotent, created on first use) ---------------------------

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await q(`
        CREATE TABLE IF NOT EXISTS repos (
          id                  BIGINT PRIMARY KEY,
          full_name           TEXT UNIQUE NOT NULL,
          stars               INTEGER DEFAULT 0,
          language            TEXT,
          last_commit_at      TEXT,
          pr_merge_rate_90d   DOUBLE PRECISION,
          median_response_hrs DOUBLE PRECISION,
          updated_at          TEXT NOT NULL
        )
      `);
      await q(`
        CREATE TABLE IF NOT EXISTS issues (
          id              BIGINT PRIMARY KEY,
          repo_id         BIGINT NOT NULL,
          repo_full       TEXT NOT NULL,
          number          INTEGER NOT NULL,
          title           TEXT NOT NULL,
          url             TEXT NOT NULL,
          language        TEXT,
          labels          TEXT,
          comments        INTEGER DEFAULT 0,
          created_at      TEXT,
          is_assigned     BOOLEAN DEFAULT FALSE,
          has_linked_pr   BOOLEAN DEFAULT FALSE,
          linked_pr_count INTEGER DEFAULT 0,
          merge_score     INTEGER DEFAULT 0,
          score_band      TEXT DEFAULT 'yellow',
          state           TEXT DEFAULT 'open',
          last_seen_at    TEXT,
          last_checked_at TEXT,
          fetched_at      TEXT NOT NULL
        )
      `);
      // migration for tables created before this column existed
      await q(`ALTER TABLE issues ADD COLUMN IF NOT EXISTS linked_pr_count INTEGER DEFAULT 0`);
      await q(`CREATE INDEX IF NOT EXISTS idx_issues_band     ON issues(score_band)`);
      await q(`CREATE INDEX IF NOT EXISTS idx_issues_language ON issues(language)`);
      await q(`CREATE INDEX IF NOT EXISTS idx_issues_score    ON issues(merge_score DESC)`);
      await q(`CREATE INDEX IF NOT EXISTS idx_issues_state    ON issues(state)`);
      await q(`CREATE INDEX IF NOT EXISTS idx_issues_checked  ON issues(last_checked_at)`);
      // covers the default read path: WHERE state='open' ORDER BY merge_score DESC
      await q(`CREATE INDEX IF NOT EXISTS idx_issues_open_score ON issues(state, merge_score DESC)`);
    })().catch((e) => {
      // Reset so a transient failure can retry on the next call.
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

// ----- row normalizers -----------------------------------------------------

function toIssueRow(r: Record<string, unknown>): IssueRow {
  return {
    id: Number(r.id),
    repo_id: Number(r.repo_id),
    repo_full: String(r.repo_full),
    number: Number(r.number),
    title: String(r.title),
    url: String(r.url),
    language: (r.language as string | null) ?? null,
    labels: (r.labels as string | null) ?? "[]",
    comments: Number(r.comments ?? 0),
    created_at: (r.created_at as string | null) ?? null,
    is_assigned: r.is_assigned ? 1 : 0,
    has_linked_pr: r.has_linked_pr ? 1 : 0,
    linked_pr_count: Number(r.linked_pr_count ?? 0),
    merge_score: Number(r.merge_score ?? 0),
    score_band: (r.score_band as IssueRow["score_band"]) ?? "yellow",
    state: (r.state as IssueRow["state"]) ?? "open",
    last_seen_at: (r.last_seen_at as string | null) ?? null,
    last_checked_at: (r.last_checked_at as string | null) ?? null,
    fetched_at: String(r.fetched_at),
    ...(r.stars != null ? { stars: Number(r.stars) } : {}),
  };
}

// ----- writes --------------------------------------------------------------

export async function upsertRepo(r: RepoInput): Promise<void> {
  await ensureSchema();
  await q(
    `INSERT INTO repos (id, full_name, stars, language, last_commit_at,
                        pr_merge_rate_90d, median_response_hrs, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       stars               = EXCLUDED.stars,
       language            = EXCLUDED.language,
       last_commit_at      = EXCLUDED.last_commit_at,
       pr_merge_rate_90d   = EXCLUDED.pr_merge_rate_90d,
       median_response_hrs = EXCLUDED.median_response_hrs,
       updated_at          = EXCLUDED.updated_at`,
    [
      r.id, r.full_name, r.stars, r.language, r.last_commit_at,
      r.pr_merge_rate_90d, r.median_response_hrs, new Date().toISOString(),
    ]
  );
}

export async function getRepoIfFresh(fullName: string, maxAgeMs: number): Promise<RepoRow | null> {
  await ensureSchema();
  const rows = await q<Record<string, unknown>>(
    `SELECT * FROM repos WHERE full_name = $1`,
    [fullName]
  );
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - new Date(String(row.updated_at)).getTime() > maxAgeMs) return null;
  return {
    id: Number(row.id),
    full_name: String(row.full_name),
    stars: Number(row.stars ?? 0),
    language: (row.language as string | null) ?? null,
    last_commit_at: (row.last_commit_at as string | null) ?? null,
    pr_merge_rate_90d: row.pr_merge_rate_90d == null ? null : Number(row.pr_merge_rate_90d),
    median_response_hrs: row.median_response_hrs == null ? null : Number(row.median_response_hrs),
    updated_at: String(row.updated_at),
  };
}

export async function upsertIssue(i: IssueInput): Promise<void> {
  await ensureSchema();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO issues (id, repo_id, repo_full, number, title, url, language,
                         labels, comments, created_at, is_assigned, has_linked_pr,
                         linked_pr_count, merge_score, score_band, state, last_seen_at,
                         last_checked_at, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'open',$16,$16,$16)
     ON CONFLICT (id) DO UPDATE SET
       title           = EXCLUDED.title,
       labels          = EXCLUDED.labels,
       comments        = EXCLUDED.comments,
       is_assigned     = EXCLUDED.is_assigned,
       has_linked_pr   = EXCLUDED.has_linked_pr,
       linked_pr_count = EXCLUDED.linked_pr_count,
       merge_score     = EXCLUDED.merge_score,
       score_band      = EXCLUDED.score_band,
       state           = 'open',
       last_seen_at    = EXCLUDED.last_seen_at,
       last_checked_at = EXCLUDED.last_checked_at,
       fetched_at      = EXCLUDED.fetched_at`,
    [
      i.id, i.repo_id, i.repo_full, i.number, i.title, i.url, i.language,
      i.labels, i.comments, i.created_at, !!i.is_assigned, !!i.has_linked_pr,
      i.linked_pr_count, i.merge_score, i.score_band, now,
    ]
  );
}

// ----- freshness / revalidation --------------------------------------------

export async function staleOpenIssues(checkedBeforeIso: string, limit: number): Promise<IssueRow[]> {
  await ensureSchema();
  const rows = await q<Record<string, unknown>>(
    `SELECT * FROM issues
     WHERE state = 'open' AND (last_checked_at IS NULL OR last_checked_at < $1)
     ORDER BY last_checked_at ASC NULLS FIRST
     LIMIT $2`,
    [checkedBeforeIso, limit]
  );
  return rows.map(toIssueRow);
}

export async function setIssueState(id: number, state: "open" | "closed"): Promise<void> {
  await ensureSchema();
  await q(
    `UPDATE issues SET state = $1, last_checked_at = $2 WHERE id = $3`,
    [state, new Date().toISOString(), id]
  );
}

// ----- reads ---------------------------------------------------------------

export async function queryIssues(query: IssueQuery): Promise<IssueRow[]> {
  await ensureSchema();
  const where: string[] = ["i.state = 'open'"];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (query.language) where.push(`i.language = ${p(query.language)}`);
  if (query.band) where.push(`i.score_band = ${p(query.band)}`);
  if (query.unclaimedOnly) where.push("i.is_assigned = FALSE AND i.has_linked_pr = FALSE");
  if (query.minStars) where.push(`r.stars >= ${p(query.minStars)}`);
  if (query.search) where.push(`i.title ILIKE ${p(likePattern(query.search))} ESCAPE '\\'`);

  const orderBy = ORDER_BY[query.sort ?? "score"];
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = query.limit ?? 60;
  const rows = await q<Record<string, unknown>>(
    `SELECT i.*, r.stars AS stars FROM issues i
     JOIN repos r ON r.id = i.repo_id
     ${whereSql}
     ORDER BY ${orderBy}
     LIMIT ${p(limit)}`,
    params
  );
  return rows.map(toIssueRow);
}

export async function languages(): Promise<string[]> {
  await ensureSchema();
  const rows = await q<{ language: string }>(
    `SELECT DISTINCT language FROM issues WHERE language IS NOT NULL AND state = 'open' ORDER BY language`
  );
  return rows.map((r) => r.language);
}

export async function stats(): Promise<{ total: number; green: number; unclaimed: number }> {
  await ensureSchema();
  const rows = await q<Record<string, unknown>>(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN score_band='green' THEN 1 ELSE 0 END) AS green,
       SUM(CASE WHEN is_assigned=FALSE AND has_linked_pr=FALSE THEN 1 ELSE 0 END) AS unclaimed
     FROM issues WHERE state = 'open'`
  );
  const row = rows[0] ?? {};
  return {
    total: Number(row.total ?? 0),
    green: Number(row.green ?? 0),
    unclaimed: Number(row.unclaimed ?? 0),
  };
}

// ----- analytics (dashboard) -----------------------------------------------

export async function analytics(): Promise<Analytics> {
  await ensureSchema();
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const sixHrAgo = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  const [base, vlh, stale, repos, byLang, top, extra] = await Promise.all([
    q<Record<string, unknown>>(
      `SELECT
         SUM(CASE WHEN state='open'   THEN 1 ELSE 0 END) AS opentotal,
         SUM(CASE WHEN state='closed' THEN 1 ELSE 0 END) AS closedtotal,
         SUM(CASE WHEN state='open' AND score_band='green'  THEN 1 ELSE 0 END) AS greentotal,
         SUM(CASE WHEN state='open' AND score_band='yellow' THEN 1 ELSE 0 END) AS yellowtotal,
         SUM(CASE WHEN state='open' AND score_band='red'    THEN 1 ELSE 0 END) AS redtotal,
         SUM(CASE WHEN state='open' AND is_assigned=FALSE AND has_linked_pr=FALSE THEN 1 ELSE 0 END) AS unclaimedtotal,
         MAX(fetched_at) AS lastingestat,
         MAX(last_checked_at) AS freshestverifiedat
       FROM issues`
    ),
    q<{ n: string }>(`SELECT COUNT(*) AS n FROM issues WHERE last_checked_at >= $1`, [hourAgo]),
    q<{ n: string }>(
      `SELECT COUNT(*) AS n FROM issues WHERE state='open' AND (last_checked_at IS NULL OR last_checked_at < $1)`,
      [sixHrAgo]
    ),
    q<{ n: string }>(`SELECT COUNT(*) AS n FROM repos`),
    q<{ language: string; count: string }>(
      `SELECT COALESCE(language,'unknown') AS language, COUNT(*) AS count
       FROM issues WHERE state='open' GROUP BY language ORDER BY count DESC`
    ),
    q<{ repo_full: string; count: string; stars: string }>(
      `SELECT i.repo_full AS repo_full, COUNT(*) AS count, COALESCE(MAX(r.stars),0) AS stars
       FROM issues i LEFT JOIN repos r ON r.id = i.repo_id
       WHERE i.state='open'
       GROUP BY i.repo_full ORDER BY count DESC, stars DESC LIMIT 10`
    ),
    q<Record<string, unknown>>(
      `SELECT
         COALESCE(AVG(i.merge_score),0) AS avgscore,
         SUM(CASE WHEN i.created_at >= $1 THEN 1 ELSE 0 END) AS openedlast7d,
         SUM(CASE WHEN r.stars < 100 THEN 1 ELSE 0 END) AS t0,
         SUM(CASE WHEN r.stars >= 100 AND r.stars < 1000 THEN 1 ELSE 0 END) AS t1,
         SUM(CASE WHEN r.stars >= 1000 AND r.stars < 10000 THEN 1 ELSE 0 END) AS t2,
         SUM(CASE WHEN r.stars >= 10000 THEN 1 ELSE 0 END) AS t3
       FROM issues i JOIN repos r ON r.id = i.repo_id WHERE i.state='open'`,
      [weekAgo]
    ),
  ]);

  const b = base[0] ?? {};
  const x = extra[0] ?? {};
  return {
    openTotal: Number(b.opentotal ?? 0),
    closedTotal: Number(b.closedtotal ?? 0),
    greenTotal: Number(b.greentotal ?? 0),
    yellowTotal: Number(b.yellowtotal ?? 0),
    redTotal: Number(b.redtotal ?? 0),
    unclaimedTotal: Number(b.unclaimedtotal ?? 0),
    reposTracked: Number(repos[0]?.n ?? 0),
    lastIngestAt: (b.lastingestat as string) ?? null,
    verifiedLastHour: Number(vlh[0]?.n ?? 0),
    staleOver6h: Number(stale[0]?.n ?? 0),
    byLanguage: byLang.map((r) => ({ language: r.language, count: Number(r.count) })),
    topRepos: top.map((r) => ({ repo_full: r.repo_full, count: Number(r.count), stars: Number(r.stars) })),
    freshestVerifiedAt: (b.freshestverifiedat as string) ?? null,
    avgScore: Math.round(Number(x.avgscore ?? 0)),
    openedLast7d: Number(x.openedlast7d ?? 0),
    starTiers: [
      { tier: "<100★", count: Number(x.t0 ?? 0) },
      { tier: "100–1k★", count: Number(x.t1 ?? 0) },
      { tier: "1k–10k★", count: Number(x.t2 ?? 0) },
      { tier: "10k+★", count: Number(x.t3 ?? 0) },
    ],
  };
}
