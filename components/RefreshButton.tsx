"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type State = "idle" | "loading" | "done" | "error";

export default function RefreshButton() {
  const router = useRouter();
  const [state, setState] = useState<State>("idle");
  const [msg, setMsg] = useState<string>("");

  async function fetchLatest() {
    if (state === "loading") return;
    setState("loading");
    setMsg("");
    try {
      const res = await fetch("/api/ingest", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setState("done");
        setMsg(`+${data.stored} stored · ${data.closed} closed · ${data.seconds.toFixed(0)}s`);
        router.refresh(); // re-render the dashboard server component with fresh numbers
        setTimeout(() => setState("idle"), 4000);
      } else {
        setState("error");
        setMsg(data.message ?? "Failed");
      }
    } catch (e) {
      setState("error");
      setMsg((e as Error).message);
    }
  }

  const label =
    state === "loading" ? "Fetching…" :
    state === "done" ? "✓ Updated" :
    state === "error" ? "Retry" :
    "↻ Fetch latest data";

  const color =
    state === "done" ? "var(--green)" :
    state === "error" ? "var(--red)" :
    "var(--accent)";

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={fetchLatest}
        disabled={state === "loading"}
        className="rounded-full px-4 py-2 text-[13px] font-semibold transition-transform hover:scale-[1.03] disabled:opacity-70"
        style={{ background: color, color: "#0c0d0a", cursor: state === "loading" ? "wait" : "pointer" }}
      >
        <span className="inline-flex items-center gap-2">
          {state === "loading" && (
            <span
              className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
              aria-hidden
            />
          )}
          {label}
        </span>
      </button>
      {msg && (
        <span className="text-[11px]" style={{ color: state === "error" ? "var(--red)" : "var(--ink-faint)" }}>
          {msg}
        </span>
      )}
      {state === "loading" && (
        <span className="text-[11px]" style={{ color: "var(--ink-faint)" }}>
          this can take 20–60s
        </span>
      )}
    </div>
  );
}
