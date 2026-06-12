// ---------------------------------------------------------------------------
// Data-layer facade. Picks a backend at runtime:
//   - DATABASE_URL set  -> Postgres (Neon)  — production on Vercel
//   - otherwise         -> SQLite (node:sqlite) — local dev, zero setup
//
// The rest of the app imports ONLY from here. Every function is async so the
// two backends share one signature. The chosen backend is imported lazily so
// the SQLite module (node:sqlite, Node-runtime only) is never pulled into a
// Postgres/edge deployment, and vice-versa.
// ---------------------------------------------------------------------------

import type {
  RepoRow,
  IssueRow,
  IssueQuery,
  Analytics,
  RepoInput,
  IssueInput,
} from "./db-types";

export type {
  RepoRow,
  IssueRow,
  IssueQuery,
  IssueSort,
  Analytics,
  RepoInput,
  IssueInput,
} from "./db-types";

export { parseIssueQuery } from "./db-types";

const usePostgres = !!process.env.DATABASE_URL;

// One shared module-level promise so the backend is imported exactly once.
type Backend = typeof import("./db-postgres");
let backendPromise: Promise<Backend> | null = null;
function backend(): Promise<Backend> {
  if (!backendPromise) {
    backendPromise = usePostgres
      ? import("./db-postgres")
      : // db-sqlite has the same exported surface; cast to the shared shape.
        (import("./db-sqlite") as unknown as Promise<Backend>);
  }
  return backendPromise;
}

// ----- writes --------------------------------------------------------------

export async function upsertRepo(r: RepoInput): Promise<void> {
  return (await backend()).upsertRepo(r);
}

export async function getRepoIfFresh(fullName: string, maxAgeMs: number): Promise<RepoRow | null> {
  return (await backend()).getRepoIfFresh(fullName, maxAgeMs);
}

export async function upsertIssue(i: IssueInput): Promise<void> {
  return (await backend()).upsertIssue(i);
}

// ----- freshness / revalidation --------------------------------------------

export async function staleOpenIssues(checkedBeforeIso: string, limit: number): Promise<IssueRow[]> {
  return (await backend()).staleOpenIssues(checkedBeforeIso, limit);
}

export async function setIssueState(id: number, state: "open" | "closed"): Promise<void> {
  return (await backend()).setIssueState(id, state);
}

// ----- reads ---------------------------------------------------------------

export async function queryIssues(q: IssueQuery): Promise<IssueRow[]> {
  return (await backend()).queryIssues(q);
}

export async function languages(): Promise<string[]> {
  return (await backend()).languages();
}

export async function stats(): Promise<{ total: number; green: number; unclaimed: number }> {
  return (await backend()).stats();
}

export async function analytics(): Promise<Analytics> {
  return (await backend()).analytics();
}
