import { computeMergeScore } from "./lib/scoring";
import { upsertRepo, upsertIssue } from "./lib/db";
import { getIssues, getStats, invalidateReadCaches } from "./lib/issues";

async function main() {
  // synthetic repo + two issues with different signals
  await upsertRepo({ id: 999001, full_name: "demo/active", stars: 1200, language: "Rust",
    last_commit_at: new Date().toISOString(), pr_merge_rate_90d: 0.7, median_response_hrs: 20 });

  const good = computeMergeScore({ isAssigned: false, hasLinkedPr: false, comments: 1,
    createdAt: new Date().toISOString(), prMergeRate90d: 0.7, medianResponseHrs: 20,
    lastCommitAt: new Date().toISOString() });
  const bad = computeMergeScore({ isAssigned: true, hasLinkedPr: false, comments: 40,
    createdAt: "2023-01-01T00:00:00Z", prMergeRate90d: 0.05, medianResponseHrs: 400,
    lastCommitAt: "2023-01-01T00:00:00Z" });

  console.log("score good:", good.score, good.band, "| reasons:", good.reasons.slice(0,3));
  console.log("score bad :", bad.score, bad.band, "| reasons:", bad.reasons.slice(0,3));

  await upsertIssue({ id: 999001, repo_id: 999001, repo_full: "demo/active", number: 1,
    title: "Fix typo in README", url: "https://x", language: "Rust", labels: '["good first issue"]',
    comments: 1, created_at: new Date().toISOString(), is_assigned: 0, has_linked_pr: 0,
    linked_pr_count: 0, merge_score: good.score, score_band: good.band });
  await upsertIssue({ id: 999002, repo_id: 999001, repo_full: "demo/active", number: 2,
    title: "Rewrite the scheduler", url: "https://y", language: "Rust", labels: '["good first issue"]',
    comments: 40, created_at: "2023-01-01T00:00:00Z", is_assigned: 1, has_linked_pr: 0,
    linked_pr_count: 0, merge_score: bad.score, score_band: bad.band });

  await invalidateReadCaches();

  // read via cache layer twice (2nd should be a cache hit)
  const a = await getIssues({ language: "Rust", limit: 10 });
  const b = await getIssues({ language: "Rust", limit: 10 });
  const unclaimed = await getIssues({ language: "Rust", unclaimedOnly: true, limit: 10 });
  const stats = await getStats();

  console.log("read count:", a.length, "| cache-hit identical:", JSON.stringify(a)===JSON.stringify(b));
  console.log("unclaimed-only count:", unclaimed.length, "(expect 1)");
  console.log("stats:", stats);
  console.log("SMOKE OK");
}
main().catch(e => { console.error(e); process.exit(1); });
