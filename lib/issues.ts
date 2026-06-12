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

// Encodes EVERY field of IssueQuery — if a new filter is added to the type,
// it is automatically part of the key (forgetting a field here serves stale
// results for the new filter; that bug already happened once).
function keyFor(q: IssueQuery): string {
  return (
    "issues:" +
    JSON.stringify(q, Object.keys(q).sort() as (keyof IssueQuery)[])
  );
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
