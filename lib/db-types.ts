// ---------------------------------------------------------------------------
// Shared data-layer types and query helpers used by BOTH backends
// (lib/db-sqlite.ts and lib/db-postgres.ts) and the facade (lib/db.ts).
// Pure types + constants only — safe to import from any runtime.
// ---------------------------------------------------------------------------

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
  is_assigned: number; // 0/1 — kept numeric so components/scoring are unchanged
  has_linked_pr: number; // 0/1
  linked_pr_count: number; // open PRs referencing this issue (competition signal)
  merge_score: number;
  score_band: "green" | "yellow" | "red";
  state: "open" | "closed";
  last_seen_at: string | null;
  last_checked_at: string | null;
  fetched_at: string;
  stars?: number; // joined from repos for display + popularity sort
}

export type IssueSort = "score" | "stars_desc" | "newest";

export interface IssueQuery {
  language?: string;
  band?: "green" | "yellow" | "red";
  unclaimedOnly?: boolean;
  minStars?: number;
  sort?: IssueSort;
  limit?: number;
  /** Case-insensitive substring match on the issue title (e.g. "docs", "cli"). */
  search?: string;
}

/** Escape a user string for use inside LIKE/ILIKE ... ESCAPE '\' patterns. */
export function likePattern(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// Whitelisted ORDER BY clauses (never interpolate user input). The column refs
// (i.*, r.*) are identical in both SQLite and Postgres dialects.
export const ORDER_BY: Record<IssueSort, string> = {
  score: "i.merge_score DESC, i.created_at DESC",
  stars_desc: "r.stars DESC, i.merge_score DESC",
  newest: "i.created_at DESC",
};

// ----- query parsing / validation -------------------------------------------
// ONE place that turns untrusted query params into a safe IssueQuery. Used by
// both the homepage (searchParams) and GET /api/issues. Invalid values are
// dropped (treated as "no filter") instead of reaching SQL.

const BANDS = new Set(["green", "yellow", "red"]);
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 60;

function posInt(v: string | undefined | null): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function parseIssueQuery(
  get: (key: string) => string | undefined | null
): IssueQuery {
  const band = get("band") ?? "";
  const sort = get("sort") ?? "";
  const search = (get("q") ?? "").trim().slice(0, 80);
  return {
    language: get("language") || undefined,
    band: BANDS.has(band) ? (band as IssueQuery["band"]) : undefined,
    unclaimedOnly: get("unclaimed") === "1",
    minStars: posInt(get("minStars")),
    sort: sort in ORDER_BY ? (sort as IssueSort) : undefined,
    limit: Math.min(posInt(get("limit")) ?? DEFAULT_LIMIT, MAX_LIMIT),
    search: search || undefined,
  };
}

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
  // richer metrics
  avgScore: number; // mean Merge Score across open issues (0..100)
  openedLast7d: number; // open issues created on GitHub within last 7 days
  starTiers: { tier: string; count: number }[]; // open issues bucketed by repo popularity
}

// The shape the ingest pipeline passes to upsertRepo / upsertIssue.
export type RepoInput = Omit<RepoRow, "updated_at">;
export type IssueInput = Omit<
  IssueRow,
  "fetched_at" | "state" | "last_seen_at" | "last_checked_at"
>;
