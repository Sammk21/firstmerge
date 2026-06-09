import { after } from "next/server";
import type { IssueQuery, IssueRow } from "@/lib/db";
import { getIssues, getLanguages, getStats } from "@/lib/issues";
import { maybeRefreshInBackground } from "@/lib/ingest";
import FilterBar from "@/components/FilterBar";
import ResultsView from "@/components/ResultsView";
import SupportBanner from "@/components/SupportBanner";
import ThemeToggle from "@/components/ThemeToggle";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;

  const q: IssueQuery = {
    language: sp.language || undefined,
    band: (sp.band as IssueQuery["band"]) || undefined,
    unclaimedOnly: sp.unclaimed === "1",
    minStars: sp.minStars ? Number(sp.minStars) : undefined,
    sort: (sp.sort as IssueQuery["sort"]) || undefined,
    includeClosed: sp.closed === "1",
    limit: 60,
  };

  let issues: IssueRow[] = [];
  let langs: string[] = [];
  let s = { total: 0, green: 0, unclaimed: 0 };
  let dbReady = true;
  try {
    [issues, langs, s] = await Promise.all([getIssues(q), getLanguages(), getStats()]);
  } catch {
    dbReady = false;
  }

  // Keep data fresh between the once-daily cron runs: after this response is
  // sent, kick off a throttled background refresh (no-op if within cooldown).
  if (dbReady) after(() => maybeRefreshInBackground());

  return (
    <main className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
      {/* header */}
      <header style={{ animation: "rise 0.5s ease both" }}>
        <div className="flex items-center justify-between text-[14px]">
          <span className="font-semibold tracking-tight" style={{ color: "var(--ink)" }}>
            FirstMerge
          </span>
          <div className="flex items-center gap-4">
            <a
              href="/dashboard"
              className="transition-colors hover:text-[color:var(--accent)]"
              style={{ color: "var(--ink-soft)" }}
            >
              Dashboard
            </a>
            <ThemeToggle />
          </div>
        </div>

        <h1
          className="mt-10 max-w-2xl text-[40px] font-semibold leading-[1.07] tracking-[-0.022em] sm:text-[52px]"
          style={{ color: "var(--ink)" }}
        >
          Good first issues that{" "}
          <span style={{ color: "var(--accent)" }}>actually get merged.</span>
        </h1>

        <p
          className="mt-5 max-w-xl text-[17px] leading-relaxed tracking-[-0.01em]"
          style={{ color: "var(--ink-soft)" }}
        >
          Every other tool just lists issues with the label. FirstMerge scores each one on
          whether your PR will land — filtering out the ones that are already claimed, stale,
          or owned by maintainers who never merge outside work. Stop getting ghosted.
        </p>

        {dbReady && s.total > 0 && (
          <div
            className="mt-9 flex flex-wrap items-stretch gap-x-10 gap-y-4 border-t pt-6"
            style={{ borderColor: "var(--line-soft)" }}
          >
            <Stat n={s.total} label="issues tracked" />
            <Stat n={s.green} label="likely to merge" color="var(--accent)" />
            <Stat n={s.unclaimed} label="unclaimed right now" color="var(--accent)" />
          </div>
        )}
      </header>

      {/* filters */}
      <div className="mt-12" style={{ animation: "rise 0.5s ease 0.08s both" }}>
        <FilterBar
          languages={langs}
          counts={{ total: s.total, green: s.green, unclaimed: s.unclaimed }}
        />
      </div>

      {/* results */}
      <div className="mt-8">
        {!dbReady ? (
          <EmptyState
            title="Cache is empty"
            body="Run `npm run ingest` to pull good-first-issues from GitHub into the local database, then refresh."
          />
        ) : issues.length === 0 ? (
          <EmptyState
            title="No issues match these filters"
            body="Loosen the filters, or run `npm run ingest` if you haven't seeded the cache yet."
          />
        ) : (
          <ResultsView issues={issues} />
        )}
      </div>

      <SupportBanner />

      <footer
        className="mt-12 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-6 text-[13px]"
        style={{ color: "var(--ink-faint)", borderColor: "var(--line-soft)" }}
      >
        <span>Data from the GitHub API · cached · always free.</span>
        <a
          href={config.repoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-[color:var(--accent)]"
          style={{ color: "var(--ink-soft)" }}
        >
          Open source (MIT)
        </a>
      </footer>
    </main>
  );
}

function Stat({ n, label, color }: { n: number; label: string; color?: string }) {
  return (
    <span className="flex flex-col">
      <strong
        className="text-[28px] font-semibold leading-none tracking-[-0.02em] tabular-nums"
        style={{ color: color ?? "var(--ink)" }}
      >
        {n.toLocaleString()}
      </strong>
      <span className="mt-1.5 text-[13px]" style={{ color: "var(--ink-faint)" }}>
        {label}
      </span>
    </span>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="rounded-2xl p-10 text-center"
      style={{ border: "1px solid var(--line)", background: "var(--bg-soft)" }}
    >
      <div className="text-[17px] font-semibold tracking-[-0.01em]" style={{ color: "var(--ink)" }}>{title}</div>
      <p className="mx-auto mt-2 max-w-sm text-[14px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>{body}</p>
    </div>
  );
}
