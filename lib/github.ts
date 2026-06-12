import { Octokit } from "@octokit/rest";
import { getOrSet, TTL } from "./cache";
import { getRepoIfFresh, type RepoRow } from "./db";

// ---------------------------------------------------------------------------
// GitHub fetch layer. Pulls good-first-issues plus the repo/maintainer signals
// the Merge Score needs. Everything here is FREE: GitHub's REST API gives an
// authenticated token 5,000 requests/hour, and we cache results in our own DB
// so users never hit GitHub live. No paid API, no paid service.
//
// Provide a token via env GITHUB_TOKEN (a free personal access token, no
// scopes needed for public data) to get the full 5k/hr limit.
//
// Rate-limit edge cases are handled centrally by callGh():
//   - primary limit hit (x-ratelimit-remaining: 0) -> sleep until reset
//   - secondary/abuse limit (403/429 + retry-after) -> respect retry-after
//   - transient 5xx / network blips -> exponential backoff
//   - gives up after MAX_RETRIES so a run can't hang forever
// ---------------------------------------------------------------------------

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN, // optional but strongly recommended
});

const MAX_RETRIES = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

interface GhError {
  status?: number;
  response?: { headers?: Record<string, string> };
  message?: string;
}

/**
 * Wrap every GitHub call so rate limits and transient errors are handled in one
 * place. `label` is just for logs.
 */
async function callGh<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { bailOnPrimaryLimit?: boolean } = {}
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      const err = e as GhError;
      const status = err.status ?? 0;
      const headers = err.response?.headers ?? {};
      attempt++;

      const retryable = status === 403 || status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt > MAX_RETRIES) throw e;

      // 1. explicit secondary-limit signal
      const retryAfter = Number(headers["retry-after"]);
      if (!Number.isNaN(retryAfter) && retryAfter > 0) {
        console.warn(`[gh] ${label}: secondary limit, waiting ${retryAfter}s (try ${attempt})`);
        await sleep(retryAfter * 1000);
        continue;
      }

      // 2. primary limit exhausted -> wait until the reset timestamp.
      //    For core calls (repo signals) the reset can be an HOUR away when
      //    unauthenticated — bail instead of hanging; the caller degrades to
      //    null signals and the scorer handles it.
      const remaining = Number(headers["x-ratelimit-remaining"]);
      const reset = Number(headers["x-ratelimit-reset"]);
      if (status === 403 && remaining === 0 && reset) {
        if (opts.bailOnPrimaryLimit) {
          console.warn(`[gh] ${label}: primary limit hit — skipping (set GITHUB_TOKEN to avoid this)`);
          throw e;
        }
        const waitMs = reset * 1000 - Date.now() + 1000;
        console.warn(`[gh] ${label}: primary limit, waiting ${(waitMs / 1000).toFixed(0)}s`);
        await sleep(waitMs);
        continue;
      }

      // 3. otherwise exponential backoff with jitter
      const backoff = Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;
      console.warn(`[gh] ${label}: ${status || "network"} error, backoff ${(backoff / 1000).toFixed(1)}s (try ${attempt})`);
      await sleep(backoff);
    }
  }
}

export interface RawIssue {
  id: number;
  number: number;
  title: string;
  url: string;
  language: string | null;
  labels: string[];
  comments: number;
  createdAt: string;
  isAssigned: boolean;
  hasLinkedPr: boolean;
  repo: RawRepo;
}

export interface RawRepo {
  id: number;
  fullName: string;
  stars: number;
  language: string | null;
  lastCommitAt: string | null;
  prMergeRate90d: number | null;
  medianResponseHrs: number | null;
}

// The canonical GitHub label. Repeating `label:` in a query is ANDed, so we
// can't OR the variants in one search — we use the one nearly every repo uses.
// (Pass a different label via `opts.label` to sweep "good-first-issue" etc.)
const DEFAULT_LABEL = "good first issue";

/**
 * Search recent open issues labeled good-first-issue across all of GitHub.
 * `languages` optionally narrows by repo language.
 */
export async function searchGoodFirstIssues(opts: {
  languages?: string[];
  label?: string;
  perPage?: number;
  pages?: number;
}): Promise<RawIssue[]> {
  const perPage = opts.perPage ?? 50;
  const pages = opts.pages ?? 1;
  const label = opts.label ?? DEFAULT_LABEL;
  const langClause = opts.languages?.length
    ? opts.languages.map((l) => `language:${l}`).join(" ")
    : "";

  // Single label (quoted), unassigned, open. Sorting goes through params below.
  const q = `label:"${label}" ${langClause} state:open no:assignee`.trim();

  const out: RawIssue[] = [];
  const repoCache = new Map<string, RawRepo>();

  for (let page = 1; page <= pages; page++) {
    const res = await callGh(`search p${page}`, () =>
      octokit.rest.search.issuesAndPullRequests({
        q,
        per_page: perPage,
        page,
        sort: "created",
        order: "desc",
        advanced_search: "true",
      })
    );

    for (const item of res.data.items) {
      // search returns issues AND PRs; skip PRs
      if (item.pull_request) continue;

      const repoFull = repoFullFromIssueUrl(item.repository_url);
      const fallbackLang = opts.languages?.[0] ?? null;
      let repo = repoCache.get(repoFull);
      if (!repo) {
        try {
          repo = await fetchRepoSignals(repoFull);
        } catch {
          // Rate-limited or unavailable — degrade gracefully rather than abort.
          repo = minimalRepo(repoFull, fallbackLang);
        }
        repoCache.set(repoFull, repo);
      }

      out.push({
        id: item.id,
        number: item.number,
        title: item.title,
        url: item.html_url,
        language: repo.language,
        labels: (item.labels ?? []).map((l: string | { name?: string }) =>
          typeof l === "string" ? l : l.name ?? ""
        ),
        comments: item.comments,
        createdAt: item.created_at,
        isAssigned: (item.assignees?.length ?? 0) > 0,
        hasLinkedPr: false, // search-level approximation; refined below if needed
        repo,
      });
    }

    if (res.data.items.length < perPage) break; // no more pages
  }

  return out;
}

function repoFullFromIssueUrl(repositoryUrl: string): string {
  // https://api.github.com/repos/OWNER/NAME -> OWNER/NAME
  const parts = repositoryUrl.split("/repos/")[1];
  return parts;
}

// Stable numeric id derived from the repo name, used only when we can't fetch
// the real repo (e.g. rate-limited). Lets the issue still persist + render.
function hashId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h) + 1_000_000_000; // offset to avoid clashing with real ids
}

function minimalRepo(fullName: string, language: string | null): RawRepo {
  return {
    id: hashId(fullName),
    fullName,
    stars: 0,
    language,
    lastCommitAt: null,
    prMergeRate90d: null,
    medianResponseHrs: null,
  };
}

/**
 * Fetch repo-level signals used by the Merge Score: stars, language,
 * last-commit recency, recent external-PR merge rate, and median maintainer
 * response time. All from free public endpoints.
 */
function repoRowToRaw(r: RepoRow): RawRepo {
  return {
    id: r.id,
    fullName: r.full_name,
    stars: r.stars,
    language: r.language,
    lastCommitAt: r.last_commit_at,
    prMergeRate90d: r.pr_merge_rate_90d,
    medianResponseHrs: r.median_response_hrs,
  };
}

export async function fetchRepoSignals(fullName: string): Promise<RawRepo> {
  // 1. Cross-run cache: if we stored this repo within the last TTL window, reuse
  //    it straight from the DB — zero GitHub calls, even across separate ingest
  //    processes and without Redis.
  const fresh = await getRepoIfFresh(fullName, TTL.repoSignals * 1000);
  if (fresh) return repoRowToRaw(fresh);

  // 2. Otherwise resolve once (also memoized in the request/run cache) and fetch.
  //    Repo+PR data is the most expensive part of ingest and changes slowly.
  return getOrSet(`repoSignals:${fullName}`, TTL.repoSignals, () => fetchRepoSignalsUncached(fullName));
}

async function fetchRepoSignalsUncached(fullName: string): Promise<RawRepo> {
  const [owner, name] = fullName.split("/");

  const repoRes = await callGh(
    `repo ${fullName}`,
    () => octokit.rest.repos.get({ owner, repo: name }),
    { bailOnPrimaryLimit: true }
  );
  const repo = repoRes.data;

  // last commit on default branch
  const lastCommitAt: string | null = repo.pushed_at ?? null;

  // recent closed PRs -> merge rate + responsiveness (sample the last ~30).
  // Both signals come from the SAME response — one API call, two signals.
  let prMergeRate90d: number | null = null;
  let medianResponseHrs: number | null = null;
  try {
    const prs = await callGh(
      `pulls ${fullName}`,
      () =>
        octokit.rest.pulls.list({
          owner,
          repo: name,
          state: "closed",
          per_page: 30,
          sort: "updated",
          direction: "desc",
        }),
      { bailOnPrimaryLimit: true }
    );
    const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
    const recent = prs.data.filter(
      (p: { updated_at: string }) => new Date(p.updated_at).getTime() >= cutoff
    );
    if (recent.length) {
      const merged = recent.filter((p: { merged_at: string | null }) => p.merged_at).length;
      prMergeRate90d = merged / recent.length;

      // Responsiveness proxy: median hours from PR opened -> decision
      // (merged or closed). Cheap and well-correlated with "will a maintainer
      // ever look at my PR" — and free, since we already have these rows.
      const decisionHrs = recent
        .map((p: { created_at: string; closed_at: string | null; merged_at: string | null }) => {
          const end = p.merged_at ?? p.closed_at;
          if (!end) return null;
          return (new Date(end).getTime() - new Date(p.created_at).getTime()) / 3_600_000;
        })
        .filter((h): h is number => h != null && h >= 0)
        .sort((a, b) => a - b);
      if (decisionHrs.length) {
        medianResponseHrs = decisionHrs[Math.floor(decisionHrs.length / 2)];
      }
    }
  } catch {
    // private/rate-limited — leave null, scorer treats unknown gracefully
  }

  return {
    id: repo.id,
    fullName,
    stars: repo.stargazers_count ?? 0,
    language: repo.language ?? null,
    lastCommitAt,
    prMergeRate90d,
    medianResponseHrs,
  };
}

// ---------------------------------------------------------------------------
// Linked-PR counts. "How many open PRs already target this issue?" is the
// competition signal: 3 people racing on one good-first-issue means your PR
// probably won't be the one merged. GitHub's REST API can't answer this
// cheaply, but GraphQL can — and we batch ~30 issues per query via aliases,
// so a full ingest costs only a handful of GraphQL points.
//
// GraphQL REQUIRES a token. Without GITHUB_TOKEN we return an empty map and
// counts stay 0 — same graceful degradation as the other repo signals.
// ---------------------------------------------------------------------------

const PR_COUNT_BATCH = 30;

interface TimelineNode {
  source?: { __typename?: string; number?: number; state?: string } | null;
}

/**
 * For each issue, count DISTINCT open PRs that cross-reference it.
 * Returns a map keyed "owner/name#number" -> count. Best-effort: issues that
 * error (deleted, access denied) are simply absent from the map.
 */
export async function fetchLinkedPrCounts(
  issues: { repoFull: string; number: number }[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!process.env.GITHUB_TOKEN || issues.length === 0) return out;

  for (let i = 0; i < issues.length; i += PR_COUNT_BATCH) {
    const batch = issues.slice(i, i + PR_COUNT_BATCH);
    const parts = batch.map((iss, idx) => {
      const [owner, name] = iss.repoFull.split("/");
      // String literals are JSON-escaped; owner/name/number come from the
      // GitHub API itself, not user input.
      return `i${idx}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
        issue(number: ${iss.number}) {
          timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 50) {
            nodes { ... on CrossReferencedEvent { source { __typename ... on PullRequest { number state } } } }
          }
        }
      }`;
    });

    try {
      const res = await callGh(
        `prCounts batch ${i / PR_COUNT_BATCH + 1}`,
        () =>
          octokit.request("POST /graphql", {
            query: `query { ${parts.join("\n")} }`,
          }),
        { bailOnPrimaryLimit: true }
      );
      // GraphQL returns partial data + errors; use whatever came back.
      const data = (res.data as { data?: Record<string, unknown> }).data ?? {};
      batch.forEach((iss, idx) => {
        const repo = data[`i${idx}`] as
          | { issue?: { timelineItems?: { nodes?: TimelineNode[] } } | null }
          | null
          | undefined;
        const nodes = repo?.issue?.timelineItems?.nodes;
        if (!nodes) return;
        const openPrs = new Set<number>();
        for (const n of nodes) {
          if (n?.source?.__typename === "PullRequest" && n.source.state === "OPEN" && n.source.number != null) {
            openPrs.add(n.source.number);
          }
        }
        out.set(`${iss.repoFull}#${iss.number}`, openPrs.size);
      });
    } catch (e) {
      // Rate-limited or transient failure — keep whatever batches succeeded.
      console.warn(`[gh] prCounts: batch failed, continuing (${(e as Error).message})`);
      break;
    }
  }
  return out;
}

/** Remaining search-API budget, so the ingest job can back off politely. */
export async function rateLimitRemaining(): Promise<number> {
  const res = await octokit.rest.rateLimit.get();
  return res.data.resources.search?.remaining ?? 0;
}

export interface RateBucket {
  limit: number;
  used: number;
  remaining: number;
  resetAt: string; // ISO
}

export interface RateUsage {
  authenticated: boolean;
  core: RateBucket;
  search: RateBucket;
  graphql: RateBucket | null;
  fetchedAt: string;
}

/** Live GitHub API usage across the buckets we care about (for the dashboard). */
export async function getRateUsage(): Promise<RateUsage> {
  const res = await octokit.rest.rateLimit.get();
  const r = res.data.resources;
  const toBucket = (b?: { limit: number; used: number; remaining: number; reset: number }): RateBucket => ({
    limit: b?.limit ?? 0,
    used: b?.used ?? 0,
    remaining: b?.remaining ?? 0,
    resetAt: new Date((b?.reset ?? 0) * 1000).toISOString(),
  });
  return {
    // core limit of 5000 means a token is in use; 60 means unauthenticated
    authenticated: (r.core?.limit ?? 60) > 60,
    core: toBucket(r.core),
    search: toBucket(r.search),
    graphql: r.graphql ? toBucket(r.graphql) : null,
    fetchedAt: new Date().toISOString(),
  };
}

export type IssueState = "open" | "closed";

/**
 * Confirm whether a single issue is still open. One cheap core call. Used by
 * the revalidation pass to catch issues that got closed/merged after ingest —
 * the whole point being to never show someone an issue that's already done.
 * Returns null if we genuinely couldn't determine it (rate-limited / network),
 * so the caller can leave the issue untouched and try again next run.
 */
export async function getIssueState(fullName: string, number: number): Promise<IssueState | null> {
  const [owner, repo] = fullName.split("/");
  try {
    const res = await callGh(
      `issue ${fullName}#${number}`,
      () => octokit.rest.issues.get({ owner, repo, issue_number: number }),
      { bailOnPrimaryLimit: true }
    );
    // A merged PR or closed issue both report state "closed" -> it's done.
    return res.data.state === "closed" ? "closed" : "open";
  } catch (e) {
    // 404 = issue/repo deleted or transferred -> treat as closed (not actionable).
    if ((e as GhError).status === 404) return "closed";
    return null;
  }
}
