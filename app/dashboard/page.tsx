import { analytics } from "@/lib/db";
import { getRateUsage, type RateUsage } from "@/lib/github";
import { getOrSet } from "@/lib/cache";
import RefreshButton from "@/components/RefreshButton";

export const dynamic = "force-dynamic";

function fmt(n: number) {
  return n.toLocaleString();
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function until(iso: string): string {
  const secs = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (secs <= 0) return "now";
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m`;
}

export default async function Dashboard() {
  const a = analytics();

  let rate: RateUsage | null = null;
  let rateErr: string | null = null;
  try {
    // /rate_limit doesn't consume quota, but cache briefly anyway.
    rate = await getOrSet("dashboard:rate", 30, () => getRateUsage());
  } catch (e) {
    rateErr = (e as Error).message;
  }

  const cacheBackend = process.env.REDIS_URL ? "Redis" : "In-memory";
  const bandTotal = Math.max(1, a.greenTotal + a.yellowTotal + a.redTotal);

  return (
    <main className="mx-auto max-w-4xl px-5 py-12">
      <header className="flex items-end justify-between" style={{ animation: "rise 0.6s ease both" }}>
        <div>
          <a href="/" className="text-[13px] hover:underline" style={{ color: "var(--accent)" }}>
            ← FirstMerge
          </a>
          <h1 className="mt-3 text-[36px] leading-none" style={{ fontFamily: "var(--serif)", color: "var(--ink)" }}>
            Dashboard
          </h1>
        </div>
        <div className="flex flex-col items-end gap-2">
          <RefreshButton />
          <div className="text-right text-[12px]" style={{ color: "var(--ink-faint)" }}>
            cache: <span style={{ color: "var(--ink-soft)" }}>{cacheBackend}</span>
            {" · "}last ingest: <span style={{ color: "var(--ink-soft)" }}>{ago(a.lastIngestAt)}</span>
          </div>
        </div>
      </header>

      {/* GitHub API usage */}
      <Section title="GitHub API usage">
        {rateErr ? (
          <Note>Couldn&apos;t read rate limits: {rateErr}</Note>
        ) : rate ? (
          <>
            <div className="mb-4 flex items-center gap-2 text-[13px]">
              <span
                className="rounded-full px-2.5 py-1"
                style={{
                  background: rate.authenticated ? "var(--green-dim)" : "var(--red-dim)",
                  color: rate.authenticated ? "var(--green)" : "var(--red)",
                  border: `1px solid ${rate.authenticated ? "var(--green)" : "var(--red)"}33`,
                }}
              >
                {rate.authenticated ? "✓ Authenticated (token active)" : "✗ Unauthenticated — set GITHUB_TOKEN"}
              </span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <RateMeter label="Core (repo / issue / PR calls)" b={rate.core} />
              <RateMeter label="Search (issue queries)" b={rate.search} />
              {rate.graphql && <RateMeter label="GraphQL" b={rate.graphql} />}
            </div>
          </>
        ) : (
          <Note>Loading…</Note>
        )}
      </Section>

      {/* Library analytics */}
      <Section title="Issue library">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat n={a.openTotal} label="open & tracked" color="var(--ink)" />
          <Stat n={a.unclaimedTotal} label="unclaimed" color="var(--accent)" />
          <Stat n={a.closedTotal} label="closed / hidden" color="var(--ink-soft)" />
          <Stat n={a.reposTracked} label="repos" color="var(--ink)" />
        </div>

        {/* score band distribution */}
        <div className="mt-6">
          <Label>Merge Score distribution</Label>
          <div className="mt-2 flex h-3 overflow-hidden rounded-full" style={{ border: "1px solid var(--line)" }}>
            <span style={{ width: `${(a.greenTotal / bandTotal) * 100}%`, background: "var(--green)" }} />
            <span style={{ width: `${(a.yellowTotal / bandTotal) * 100}%`, background: "var(--amber)" }} />
            <span style={{ width: `${(a.redTotal / bandTotal) * 100}%`, background: "var(--red)" }} />
          </div>
          <div className="mt-2 flex gap-4 text-[12px]" style={{ color: "var(--ink-soft)" }}>
            <span style={{ color: "var(--green)" }}>● {fmt(a.greenTotal)} green</span>
            <span style={{ color: "var(--amber)" }}>● {fmt(a.yellowTotal)} mixed</span>
            <span style={{ color: "var(--red)" }}>● {fmt(a.redTotal)} risky</span>
          </div>
        </div>
      </Section>

      {/* Freshness */}
      <Section title="Freshness">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat n={a.verifiedLastHour} label="verified in last hour" color="var(--green)" />
          <Stat n={a.staleOver6h} label="stale (>6h unverified)" color={a.staleOver6h > 0 ? "var(--amber)" : "var(--ink-soft)"} />
          <div>
            <div className="text-[22px]" style={{ color: "var(--ink)", fontFamily: "var(--serif)" }}>
              {ago(a.freshestVerifiedAt)}
            </div>
            <div className="text-[12px]" style={{ color: "var(--ink-soft)" }}>most recent check</div>
          </div>
        </div>
        <Note>
          Each ingest re-checks the oldest-verified open issues against GitHub and hides any that were closed or
          merged — so the list stays trustworthy.
        </Note>
      </Section>

      {/* By language */}
      {a.byLanguage.length > 0 && (
        <Section title="Open issues by language">
          <div className="space-y-2">
            {a.byLanguage.slice(0, 8).map((l) => {
              const pct = (l.count / Math.max(1, a.byLanguage[0].count)) * 100;
              return (
                <div key={l.language} className="flex items-center gap-3">
                  <span className="w-24 shrink-0 text-[13px]" style={{ color: "var(--ink-soft)" }}>{l.language}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full" style={{ background: "var(--bg-soft)" }}>
                    <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: "var(--accent)" }} />
                  </div>
                  <span className="w-10 shrink-0 text-right text-[13px]" style={{ color: "var(--ink)" }}>{fmt(l.count)}</span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* Top repos */}
      {a.topRepos.length > 0 && (
        <Section title="Top repos by open good-first-issues">
          <div className="overflow-hidden rounded-lg" style={{ border: "1px solid var(--line)" }}>
            {a.topRepos.map((r, i) => (
              <a
                key={r.repo_full}
                href={`https://github.com/${r.repo_full}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between px-4 py-2.5 text-[13px] hover:underline"
                style={{ borderTop: i ? "1px solid var(--line)" : "none", color: "var(--ink-soft)" }}
              >
                <span style={{ color: "var(--ink)" }}>{r.repo_full}</span>
                <span>
                  {fmt(r.count)} issues{r.stars ? ` · ★ ${fmt(r.stars)}` : ""}
                </span>
              </a>
            ))}
          </div>
        </Section>
      )}

      <footer className="mt-12 text-[12px]" style={{ color: "var(--ink-faint)" }}>
        {rate ? `Rate data fetched ${ago(rate.fetchedAt)}.` : ""} Numbers reflect the local cache; run an ingest to refresh.
      </footer>
    </main>
  );
}

// ----- little presentational helpers ---------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="mt-6 rounded-xl p-5"
      style={{ border: "1px solid var(--line)", background: "var(--panel)", animation: "rise 0.6s ease 0.05s both" }}
    >
      <h2 className="mb-4 text-[12px] uppercase tracking-wider" style={{ color: "var(--ink-faint)" }}>{title}</h2>
      {children}
    </section>
  );
}

function Stat({ n, label, color }: { n: number; label: string; color?: string }) {
  return (
    <div>
      <div className="text-[26px] leading-none" style={{ color: color ?? "var(--ink)", fontFamily: "var(--serif)" }}>
        {fmt(n)}
      </div>
      <div className="mt-1 text-[12px]" style={{ color: "var(--ink-soft)" }}>{label}</div>
    </div>
  );
}

function RateMeter({ label, b }: { label: string; b: { limit: number; used: number; remaining: number; resetAt: string } }) {
  const pct = b.limit ? (b.used / b.limit) * 100 : 0;
  const hot = pct > 80;
  return (
    <div className="rounded-lg p-3" style={{ background: "var(--bg-soft)", border: "1px solid var(--line)" }}>
      <div className="flex items-baseline justify-between">
        <span className="text-[13px]" style={{ color: "var(--ink)" }}>{label}</span>
        <span className="text-[12px]" style={{ color: "var(--ink-soft)" }}>{fmt(b.remaining)} / {fmt(b.limit)} left</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full" style={{ background: "var(--line)" }}>
        <span
          className="block h-full rounded-full"
          style={{ width: `${pct}%`, background: hot ? "var(--red)" : "var(--green)" }}
        />
      </div>
      <div className="mt-1.5 text-[11px]" style={{ color: "var(--ink-faint)" }}>
        {fmt(b.used)} used · resets in {until(b.resetAt)}
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] uppercase tracking-wider" style={{ color: "var(--ink-faint)" }}>{children}</div>;
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 text-[12px] leading-relaxed" style={{ color: "var(--ink-faint)" }}>{children}</p>;
}
