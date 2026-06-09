// ---------------------------------------------------------------------------
// Reusable ingest pipeline. Called by both the CLI (scripts/ingest.ts) and the
// "Fetch latest data" button (POST /api/ingest). Pulls good-first-issues,
// scores them, caches them, then revalidates older issues to hide closed ones.
// ---------------------------------------------------------------------------

import { searchGoodFirstIssues, rateLimitRemaining, getIssueState } from "./github";
import { computeMergeScore } from "./scoring";
import { upsertRepo, upsertIssue, staleOpenIssues, setIssueState } from "./db";
import { invalidateReadCaches } from "./issues";

const REVALIDATE_BUDGET = Number(process.env.REVALIDATE_BUDGET ?? 150);
const REVALIDATE_AFTER_HOURS = Number(process.env.REVALIDATE_AFTER_HOURS ?? 6);

// Steady-drip bounds. Each tick does (languages × pages) Search-API calls; the
// authenticated Search limit is ~30/min, so the defaults below (6 langs × 1
// page = 6 search calls, spaced 1.5s apart) sit far under it. Revalidation uses
// the separate Core bucket (5,000/hr). Override via env if you want a heavier
// or lighter cadence — keep langs×pages well under ~25 to stay safe.
const DEFAULT_LANGUAGES = (process.env.INGEST_LANGUAGES?.split(",").map((s) => s.trim()).filter(Boolean)) ?? [
  "TypeScript", "JavaScript", "Python", "Go", "Rust", "Java",
];
const DEFAULT_PAGES = Number(process.env.INGEST_PAGES ?? 1);
const DEFAULT_PER_PAGE = Number(process.env.INGEST_PER_PAGE ?? 40);

export interface IngestSummary {
  ok: boolean;
  stored: number;
  closed: number;
  repos: number;
  seconds: number;
  message?: string;
}

export interface IngestOptions {
  languages?: string[];
  perPage?: number;
  pages?: number;
  log?: (line: string) => void;
}

// Simple in-process guard so two ingests can't run at once (e.g. button mashing).
let running = false;
export function isIngestRunning() {
  return running;
}

export async function runIngest(opts: IngestOptions = {}): Promise<IngestSummary> {
  const log = opts.log ?? (() => {});
  const languages = opts.languages ?? DEFAULT_LANGUAGES;
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
  const pages = opts.pages ?? DEFAULT_PAGES;

  if (running) {
    return { ok: false, stored: 0, closed: 0, repos: 0, seconds: 0, message: "An ingest is already running." };
  }
  running = true;
  const startedAt = Date.now();

  try {
    log("FirstMerge ingest starting…");
    const remaining = await rateLimitRemaining().catch(() => -1);
    log(`Search API budget remaining: ${remaining}`);
    if (remaining === 0) {
      return {
        ok: false, stored: 0, closed: 0, repos: 0,
        seconds: (Date.now() - startedAt) / 1000,
        message: "GitHub search rate limit exhausted. Set GITHUB_TOKEN or wait a minute.",
      };
    }

    let stored = 0;
    const seenRepos = new Set<number>();

    for (const language of languages) {
      log(`Fetching: ${language}`);
      let issues;
      try {
        issues = await searchGoodFirstIssues({ languages: [language], perPage, pages });
      } catch (err) {
        log(`  skipped ${language}: ${(err as Error).message}`);
        continue;
      }

      for (const it of issues) {
        if (!seenRepos.has(it.repo.id)) {
          await upsertRepo({
            id: it.repo.id,
            full_name: it.repo.fullName,
            stars: it.repo.stars,
            language: it.repo.language,
            last_commit_at: it.repo.lastCommitAt,
            pr_merge_rate_90d: it.repo.prMergeRate90d,
            median_response_hrs: it.repo.medianResponseHrs,
          });
          seenRepos.add(it.repo.id);
        }

        const { score, band } = computeMergeScore({
          isAssigned: it.isAssigned,
          hasLinkedPr: it.hasLinkedPr,
          comments: it.comments,
          createdAt: it.createdAt,
          prMergeRate90d: it.repo.prMergeRate90d,
          medianResponseHrs: it.repo.medianResponseHrs,
          lastCommitAt: it.repo.lastCommitAt,
        });

        await upsertIssue({
          id: it.id,
          repo_id: it.repo.id,
          repo_full: it.repo.fullName,
          number: it.number,
          title: it.title,
          url: it.url,
          language: it.language,
          labels: JSON.stringify(it.labels),
          comments: it.comments,
          created_at: it.createdAt,
          is_assigned: it.isAssigned ? 1 : 0,
          has_linked_pr: it.hasLinkedPr ? 1 : 0,
          merge_score: score,
          score_band: band,
        });
        stored++;
      }
      log(`  stored ${issues.length} issues`);
      await new Promise((r) => setTimeout(r, 1500)); // be polite to the search API
    }

    const closed = await revalidate(log);
    await invalidateReadCaches();

    const seconds = (Date.now() - startedAt) / 1000;
    log(`Done. ${stored} stored, ${closed} closed, ${seenRepos.size} repos, ${seconds.toFixed(1)}s.`);
    return { ok: true, stored, closed, repos: seenRepos.size, seconds };
  } finally {
    running = false;
  }
}

async function revalidate(log: (l: string) => void): Promise<number> {
  const cutoff = new Date(Date.now() - REVALIDATE_AFTER_HOURS * 3600 * 1000).toISOString();
  const candidates = await staleOpenIssues(cutoff, REVALIDATE_BUDGET);
  if (!candidates.length) return 0;

  log(`Revalidating ${candidates.length} cached issues…`);
  let closedCount = 0;
  for (const issue of candidates) {
    const state = await getIssueState(issue.repo_full, issue.number);
    if (state === null) {
      log("  revalidation stopped early (rate limit / network)");
      break;
    }
    await setIssueState(issue.id, state);
    if (state === "closed") closedCount++;
  }
  log(`  ${closedCount} now closed (hidden)`);
  return closedCount;
}
