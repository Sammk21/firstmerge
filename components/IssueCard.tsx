import type { IssueRow } from "@/lib/db";

const BAND: Record<string, { color: string; bg: string; label: string }> = {
  green: { color: "var(--green)", bg: "var(--green-dim)", label: "Likely to merge" },
  yellow: { color: "var(--amber)", bg: "var(--amber-dim)", label: "Mixed signals" },
  red: { color: "var(--red)", bg: "var(--red-dim)", label: "Risky" },
};

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function verifiedAgo(iso: string | null): string {
  if (!iso) return "unverified";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `verified ${Math.max(1, mins)}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `verified ${hrs}h ago`;
  return `verified ${Math.floor(hrs / 24)}d ago`;
}

function starLabel(stars?: number): string | null {
  if (!stars) return null;
  if (stars >= 1000) return `${(stars / 1000).toFixed(stars >= 10000 ? 0 : 1)}k`;
  return String(stars);
}

// Small SVG ring showing the Merge Score 0..100, colored by band.
function ScoreRing({ score, color }: { score: number; color: string }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  const dash = (score / 100) * c;
  return (
    <svg width="46" height="46" viewBox="0 0 46 46" className="shrink-0">
      <circle cx="23" cy="23" r={r} fill="none" stroke="var(--line-soft)" strokeWidth="3.5" />
      <circle
        cx="23" cy="23" r={r} fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round"
        strokeDasharray={`${dash} ${c}`} transform="rotate(-90 23 23)"
      />
      <text x="23" y="27" textAnchor="middle" fontSize="14" fontWeight="600" fill="var(--ink)" fontFamily="var(--sans)">
        {score}
      </text>
    </svg>
  );
}

// A short, human read of the strongest signals — computed from stored fields.
function signals(issue: IssueRow): { good: boolean; text: string }[] {
  const out: { good: boolean; text: string }[] = [];
  const available = !issue.is_assigned && !issue.has_linked_pr;
  out.push(available
    ? { good: true, text: "Unclaimed — free to take" }
    : {
        good: false,
        text: issue.is_assigned
          ? "Already assigned"
          : issue.linked_pr_count > 1
            ? `${issue.linked_pr_count} PRs already racing for this`
            : "Has an open PR",
      });

  if (issue.stars && issue.stars >= 1000) out.push({ good: true, text: `Popular repo (${starLabel(issue.stars)}★)` });
  else if (issue.stars && issue.stars < 50) out.push({ good: false, text: "Small/quiet repo" });

  if (issue.comments >= 25) out.push({ good: false, text: "Long thread — may be complex" });
  else if (issue.comments <= 3) out.push({ good: true, text: "Clean, short discussion" });

  if (issue.created_at) {
    const days = Math.floor((Date.now() - new Date(issue.created_at).getTime()) / 86400000);
    if (days <= 30) out.push({ good: true, text: "Recently opened" });
    else if (days >= 365) out.push({ good: false, text: "Over a year old" });
  }
  return out.slice(0, 4);
}

export default function IssueCard({
  issue,
  index,
  view = "list",
}: {
  issue: IssueRow;
  index: number;
  view?: "list" | "grid";
}) {
  const band = BAND[issue.score_band] ?? BAND.yellow;
  const labels: string[] = (() => { try { return JSON.parse(issue.labels); } catch { return []; } })();
  const available = !issue.is_assigned && !issue.has_linked_pr;
  const stars = starLabel(issue.stars);
  const sigs = signals(issue);

  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`issue-card group relative block h-full overflow-hidden rounded-2xl p-4 ${
        view === "grid" ? "flex flex-col" : ""
      } ${issue.state === "closed" ? "opacity-60" : ""}`}
      style={{
        animation: `rise 0.45s ease ${Math.min(index * 0.025, 0.3)}s both`,
      }}
    >
      <div className="flex items-start gap-4">
        <ScoreRing score={issue.merge_score} color={band.color} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--ink-faint)" }}>
            <span className="truncate">{issue.repo_full}</span>
            {stars && (
              <span className="shrink-0 rounded-full px-1.5 py-0.5" style={{ background: "var(--bg-soft)", color: "var(--amber)" }}>
                ★ {stars}
              </span>
            )}
          </div>

          <h3
            className="mt-1 text-[15px] leading-snug transition-colors group-hover:underline"
            style={{ color: "var(--ink)" }}
          >
            {issue.title}
          </h3>

          {/* meta row */}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]" style={{ color: "var(--ink-soft)" }}>
            {issue.state === "closed" ? (
              <span
                className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{ background: "var(--bg-soft)", color: "var(--ink-faint)" }}
              >
                Closed
              </span>
            ) : (
              <span
                className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{ background: band.bg, color: band.color }}
              >
                {band.label}
              </span>
            )}
            {issue.state !== "closed" && (
              <span style={{ color: available ? "var(--green)" : "var(--ink-faint)" }}>
                {available
                  ? "● unclaimed"
                  : issue.is_assigned
                    ? "○ assigned"
                    : issue.linked_pr_count > 0
                      ? `○ ${issue.linked_pr_count} open PR${issue.linked_pr_count > 1 ? "s" : ""}`
                      : "○ has PR"}
              </span>
            )}
            {issue.language && <span>· {issue.language}</span>}
            {issue.comments > 0 && <span>· 💬 {issue.comments}</span>}
            {issue.created_at && <span>· {timeAgo(issue.created_at)}</span>}
            <span style={{ color: "var(--green)" }}>· ✓ {verifiedAgo(issue.last_checked_at)}</span>
          </div>
        </div>

        <span
          className="shrink-0 translate-x-1 self-center text-[18px] opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100"
          style={{ color: band.color }}
          aria-hidden
        >
          →
        </span>
      </div>

      {/* hover-reveal: why this score */}
      <div
        className="grid grid-rows-[0fr] transition-all duration-300 group-hover:grid-rows-[1fr]"
      >
        <div className="overflow-hidden">
          <div
            className="mt-3 flex flex-wrap gap-1.5 border-t pt-3"
            style={{ borderColor: "var(--line)" }}
          >
            {sigs.map((s) => (
              <span
                key={s.text}
                className="rounded-full px-2 py-1 text-[11px]"
                style={{
                  background: s.good ? "var(--green-dim)" : "var(--red-dim)",
                  color: s.good ? "var(--green)" : "var(--red)",
                }}
              >
                {s.good ? "✓" : "✕"} {s.text}
              </span>
            ))}
            {labels.slice(0, 2).map((l) => (
              <span key={l} className="rounded-full px-2 py-1 text-[11px]" style={{ background: "var(--bg-soft)", color: "var(--ink-faint)" }}>
                {l}
              </span>
            ))}
          </div>
        </div>
      </div>
    </a>
  );
}
