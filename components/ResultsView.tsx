"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { IssueRow } from "@/lib/db";
import IssueCard from "@/components/IssueCard";

type View = "list" | "grid";

// ---- tiny localStorage-backed preference store -----------------------------
// Read through useSyncExternalStore so there's no mount-time setState (and no
// hydration mismatch — the server snapshot is the provided default).
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}
function getPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function setPref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
  listeners.forEach((cb) => cb());
}

// ---- component -------------------------------------------------------------

export default function ResultsView({ issues }: { issues: IssueRow[] }) {
  const view = useSyncExternalStore(subscribe, () => getPref("view", "list") as View, () => "list" as View);
  const grouped = useSyncExternalStore(subscribe, () => getPref("group", "0") === "1", () => false);

  const choose = useCallback((next: View) => setPref("view", next), []);
  const toggleGroup = useCallback(() => setPref("group", grouped ? "0" : "1"), [grouped]);

  // Group issues by repo, ordered by issue count desc then best score.
  const groups = useMemo(() => {
    const map = new Map<string, IssueRow[]>();
    for (const it of issues) {
      const arr = map.get(it.repo_full) ?? [];
      arr.push(it);
      map.set(it.repo_full, arr);
    }
    return [...map.entries()]
      .map(([repo, items]) => ({
        repo,
        items,
        stars: items[0]?.stars ?? 0,
        topScore: Math.max(...items.map((i) => i.merge_score)),
        topBand: items.reduce((best, i) => (i.merge_score > best.merge_score ? i : best), items[0])
          .score_band,
        language: items.find((i) => i.language)?.language ?? null,
      }))
      .sort((a, b) => b.items.length - a.items.length || b.topScore - a.topScore);
  }, [issues]);

  const multiRepoGroups = groups.filter((g) => g.items.length > 1).length;
  const gridCls = view === "grid" ? "grid grid-cols-1 gap-3 sm:grid-cols-2" : "space-y-3";

  return (
    <section>
      {/* header: count + controls */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-[13px]" style={{ color: "var(--ink-faint)" }}>
          {issues.length} {issues.length === 1 ? "issue" : "issues"}
          {grouped && ` · ${groups.length} repos`}
        </span>

        <div className="flex items-center gap-2">
          {/* Group toggle — highlighted when there are repos with several issues */}
          <button
            type="button"
            onClick={toggleGroup}
            aria-pressed={grouped}
            title="Group issues by repository"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] transition-colors"
            style={{
              border: `1px solid ${grouped ? "var(--accent)" : "var(--line)"}`,
              background: grouped ? "var(--green-dim)" : "var(--bg-soft)",
              color: grouped ? "var(--accent)" : "var(--ink-soft)",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 7h18M6 12h12M9 17h6" />
            </svg>
            Group
            {!grouped && multiRepoGroups > 0 && (
              <span className="rounded-full px-1.5 text-[10px]" style={{ background: "var(--accent)", color: "#fff" }}>
                {multiRepoGroups}
              </span>
            )}
          </button>

          {/* List / grid segmented control */}
          <div
            className="inline-flex items-center gap-0.5 rounded-lg p-0.5"
            style={{ background: "var(--bg-soft)", border: "1px solid var(--line)" }}
            role="group"
            aria-label="View"
          >
            <Segment active={view === "list"} onClick={() => choose("list")} label="List">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
              </svg>
            </Segment>
            <Segment active={view === "grid"} onClick={() => choose("grid")} label="Grid">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
                <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
                <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" />
                <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
                <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
              </svg>
            </Segment>
          </div>
        </div>
      </div>

      {grouped ? (
        <div className="space-y-3">
          {groups.map((g, gi) => (
            <details
              key={g.repo}
              open={gi < 6}
              className="overflow-hidden rounded-2xl"
              style={{ border: "1px solid var(--line)", background: "var(--bg-soft)" }}
            >
              <summary
                className="group/sum flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[14px] select-none transition-colors hover:bg-[color:var(--panel)]"
                style={{ color: "var(--ink)" }}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {/* chevron: tells users this row expands; rotates when open */}
                  <svg
                    width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden
                    className="group-chevron shrink-0 transition-transform duration-200"
                    style={{ color: "var(--ink-faint)" }}
                  >
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                  <span className="truncate font-semibold tracking-[-0.01em]">{g.repo}</span>
                  {g.stars > 0 && (
                    <span className="shrink-0 text-[12px]" style={{ color: "var(--amber)" }}>★ {starLabel(g.stars)}</span>
                  )}
                  {g.language && (
                    <span className="hidden shrink-0 text-[12px] sm:inline" style={{ color: "var(--ink-faint)" }}>
                      · {g.language}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-[12px]" style={{ color: "var(--ink-faint)" }}>
                  {/* best score in this repo — judge the group before opening it */}
                  <span
                    className="rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums"
                    style={{
                      background: `var(--${g.topBand === "green" ? "green" : g.topBand === "yellow" ? "amber" : "red"}-dim)`,
                      color: `var(--${g.topBand === "green" ? "green" : g.topBand === "yellow" ? "amber" : "red"})`,
                    }}
                    title="Best Merge Score in this repo"
                  >
                    best {g.topScore}
                  </span>
                  {g.items.length} {g.items.length === 1 ? "issue" : "issues"}
                </span>
              </summary>
              <div className="px-3 pb-3">
                <div className={gridCls}>
                  {g.items.map((issue, i) => (
                    <IssueCard key={issue.id} issue={issue} index={i} view={view} />
                  ))}
                </div>
              </div>
            </details>
          ))}
        </div>
      ) : (
        <div className={gridCls}>
          {issues.map((issue, i) => (
            <IssueCard key={issue.id} issue={issue} index={i} view={view} />
          ))}
        </div>
      )}
    </section>
  );
}

function starLabel(stars: number): string {
  if (stars >= 1000) return `${(stars / 1000).toFixed(stars >= 10000 ? 0 : 1)}k`;
  return String(stars);
}

function Segment({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className="inline-flex h-7 w-8 items-center justify-center rounded-md transition-colors"
      style={{
        background: active ? "var(--panel)" : "transparent",
        color: active ? "var(--ink)" : "var(--ink-faint)",
        boxShadow: active ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
      }}
    >
      {children}
    </button>
  );
}
