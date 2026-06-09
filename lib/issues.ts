// ---------------------------------------------------------------------------
// Cached read API. The page and the /api/issues route call these instead of
// hitting SQLite directly, so repeated/identical requests are served from the
// cache (Redis or in-memory). Cache key encodes the full filter set.
// ---------------------------------------------------------------------------

import {
  queryIssues,
  languages as dbLanguages,
  stats as dbStats,
  type IssueQuery,
  type IssueRow,
} from "./db";
import { getOrSet, invalidatePrefix, TTL } from "./cache";

function keyFor(q: IssueQuery): string {
  return [
    "issues",
    q.language ?? "_",
    q.band ?? "_",
    q.unclaimedOnly ? "u1" : "u0",
    q.minStars ?? 0,
    q.sort ?? "score",
    q.limit ?? 60,
  ].join(":");
}

export function getIssues(q: IssueQuery): Promise<IssueRow[]> {
  return getOrSet(keyFor(q), TTL.issueList, () => queryIssues(q));
}

export function getLanguages(): Promise<string[]> {
  return getOrSet("languages", TTL.languages, () => dbLanguages());
}

export function getStats(): Promise<{ total: number; green: number; unclaimed: number }> {
  return getOrSet("stats", TTL.stats, () => dbStats());
}

/** Called by the ingest job after it writes fresh data, so users see it now. */
export function invalidateReadCaches(): Promise<void> {
  return Promise.all([
    invalidatePrefix("issues"),
    invalidatePrefix("languages"),
    invalidatePrefix("stats"),
  ]).then(() => undefined);
}
