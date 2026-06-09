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
  merge_score: number;
  score_band: "green" | "yellow" | "red";
  state: "open" | "closed";
  last_seen_at: string | null;
  last_checked_at: string | null;
  fetched_at: string;
  stars?: number; // joined from repos for display + popularity sort
}

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

// Whitelisted ORDER BY clauses (never interpolate user input). The column refs
// (i.*, r.*) are identical in both SQLite and Postgres dialects.
export const ORDER_BY: Record<IssueSort, string> = {
  score: "i.merge_score DESC, i.created_at DESC",
  stars_desc: "r.stars DESC, i.merge_score DESC",
  stars_asc: "r.stars ASC, i.merge_score DESC",
  newest: "i.created_at DESC",
};

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

// The shape the ingest pipeline passes to upsertRepo / upsertIssue.
export type RepoInput = Omit<RepoRow, "updated_at">;
export type IssueInput = Omit<
  IssueRow,
  "fetched_at" | "state" | "last_seen_at" | "last_checked_at"
>;
