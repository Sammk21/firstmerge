// ---------------------------------------------------------------------------
// The Merge Score — the heart of FirstMerge.
//
// Every other tool answers "does this issue have the good-first-issue label?".
// We answer the question that actually matters to a contributor:
//   "If I spend my weekend on this, will my PR get merged — or get ghosted?"
//
// The score (0..100) blends signals the competition ignores. Tune the weights
// freely; they're intentionally explicit so the badge can explain *why*.
// ---------------------------------------------------------------------------

export interface ScoreSignals {
  isAssigned: boolean;        // someone is already assigned
  hasLinkedPr: boolean;       // an open PR already references this issue
  comments: number;          // huge threads = rabbit holes
  createdAt: string | null;   // issue age
  // repo-level signals (may be unknown -> null)
  prMergeRate90d: number | null;   // 0..1 share of external PRs merged recently
  medianResponseHrs: number | null; // median hours from PR opened -> decision (merged/closed)
  lastCommitAt: string | null;     // repo liveness
}

export interface ScoreResult {
  score: number;                 // 0..100
  band: "green" | "yellow" | "red";
  reasons: string[];             // human-readable, drives the tooltip
}

const DAY = 1000 * 60 * 60 * 24;

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / DAY;
}

export function computeMergeScore(s: ScoreSignals): ScoreResult {
  let score = 50; // neutral baseline
  const reasons: string[] = [];

  // "Green" is a promise: YOUR PR on this issue will likely land. Two cases
  // must never make that promise, regardless of how many points accumulate:
  //   - claimed issues (someone else is already on it)
  //   - repos we have no maintainer data for (no evidence either way)
  const claimed = s.isAssigned || s.hasLinkedPr;
  const unknownMaintainer = s.prMergeRate90d == null && s.medianResponseHrs == null;

  // 1. Availability — the single biggest time-waster the competition ignores.
  if (s.isAssigned) {
    score -= 35;
    reasons.push("Already assigned to someone");
  } else if (s.hasLinkedPr) {
    score -= 30;
    reasons.push("An open PR already addresses this");
  } else {
    score += 15;
    reasons.push("Unclaimed — open to take");
  }

  // 2. Maintainer merge behaviour — will they actually accept outside work?
  if (s.prMergeRate90d != null) {
    if (s.prMergeRate90d >= 0.5) { score += 15; reasons.push("Maintainers merge most external PRs"); }
    else if (s.prMergeRate90d >= 0.2) { score += 5; reasons.push("Maintainers merge some external PRs"); }
    else { score -= 15; reasons.push("Maintainers rarely merge external PRs"); }
  }

  // 3. Responsiveness — slow/zero PR turnaround is how people get ghosted.
  if (s.medianResponseHrs != null) {
    if (s.medianResponseHrs <= 48) { score += 12; reasons.push("PRs usually get a decision within 2 days"); }
    else if (s.medianResponseHrs <= 168) { score += 4; reasons.push("PRs get a decision within a week"); }
    else { score -= 12; reasons.push("PRs sit a long time before a decision"); }
  }

  // 4. Repo liveness — dead repos never merge anything.
  const commitDays = daysSince(s.lastCommitAt);
  if (commitDays != null) {
    if (commitDays <= 30) { score += 8; reasons.push("Repo is actively maintained"); }
    else if (commitDays <= 120) { score += 2; }
    else { score -= 12; reasons.push("Repo looks inactive"); }
  }

  // 5. Beginner-fit — giant comment threads usually mean a rabbit hole.
  if (s.comments >= 25) { score -= 10; reasons.push("Long discussion thread — may be complex"); }
  else if (s.comments <= 3) { score += 4; }

  // 6. Freshness — fresh issues are likelier to still be relevant & available.
  const issueDays = daysSince(s.createdAt);
  if (issueDays != null) {
    if (issueDays <= 30) { score += 6; reasons.push("Recently opened"); }
    else if (issueDays >= 365) { score -= 8; reasons.push("Over a year old — may be stale"); }
  }

  if (unknownMaintainer) reasons.push("Limited maintainer data");

  score = Math.max(0, Math.min(100, Math.round(score)));

  let band: ScoreResult["band"] =
    score >= 65 ? "green" : score >= 40 ? "yellow" : "red";
  if (band === "green" && (claimed || unknownMaintainer)) band = "yellow";

  return { score, band, reasons };
}
