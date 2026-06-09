"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { IssueRow } from "@/lib/db";
import IssueCard from "@/components/IssueCard";

type View = "list" | "grid";

// A tiny localStorage-backed store for the view preference, read through
// useSyncExternalStore so there's no mount-time setState (and no hydration
// mismatch — the server snapshot is always "list").
const viewListeners = new Set<() => void>();

function subscribe(cb: () => void) {
  viewListeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    viewListeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

function getViewSnapshot(): View {
  try {
    const saved = localStorage.getItem("view");
    if (saved === "grid" || saved === "list") return saved;
  } catch {
    /* ignore */
  }
  return "list";
}

function setStoredView(next: View) {
  try {
    localStorage.setItem("view", next);
  } catch {
    /* ignore */
  }
  viewListeners.forEach((cb) => cb());
}

export default function ResultsView({ issues }: { issues: IssueRow[] }) {
  const view = useSyncExternalStore(subscribe, getViewSnapshot, () => "list" as View);
  const choose = useCallback((next: View) => setStoredView(next), []);

  return (
    <section>
      {/* header: result count + segmented control */}
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13px]" style={{ color: "var(--ink-faint)" }}>
          {issues.length} {issues.length === 1 ? "issue" : "issues"}
        </span>

        {/* Apple-style segmented control */}
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

      <div className={view === "grid" ? "grid grid-cols-1 gap-3 sm:grid-cols-2" : "space-y-3"}>
        {issues.map((issue, i) => (
          <IssueCard key={issue.id} issue={issue} index={i} view={view} />
        ))}
      </div>
    </section>
  );
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
