"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback } from "react";

const BANDS = [
  { key: "", label: "All signals" },
  { key: "green", label: "Likely to merge" },
  { key: "yellow", label: "Mixed" },
  { key: "red", label: "Risky" },
];

const SORTS = [
  { key: "", label: "Best match" },
  { key: "stars_desc", label: "★ Most popular" },
  { key: "stars_asc", label: "Least popular" },
  { key: "newest", label: "Newest" },
];

type Counts = { total: number; green: number; unclaimed: number };

export default function FilterBar({
  languages,
  counts,
}: {
  languages: string[];
  counts?: Counts;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const setParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router]
  );

  const band = params.get("band") ?? "";
  const language = params.get("language") ?? "";
  const unclaimed = params.get("unclaimed") === "1";
  const closed = params.get("closed") === "1";
  const sort = params.get("sort") ?? "";
  const minStars = params.get("minStars") ?? "";

  return (
    <div className="space-y-3">
      {/* row 1: band pills */}
      <div className="flex flex-wrap gap-1.5">
        {BANDS.map((b) => {
          const active = band === b.key;
          const count =
            b.key === "" ? counts?.total : b.key === "green" ? counts?.green : undefined;
          return (
            <button
              key={b.key || "all"}
              onClick={() => setParam("band", b.key)}
              className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] transition-colors"
              style={{
                border: `1px solid ${active ? "var(--accent)" : "var(--line)"}`,
                background: active ? "var(--accent)" : "transparent",
                color: active ? "#ffffff" : "var(--ink-soft)",
                fontWeight: active ? 590 : 400,
              }}
            >
              {b.label}
              {count != null && (
                <span
                  className="rounded-full px-1.5 text-[11px] tabular-nums"
                  style={{
                    background: active ? "rgba(255,255,255,0.22)" : "var(--bg-soft)",
                    color: active ? "#ffffff" : "var(--ink-faint)",
                  }}
                >
                  {count.toLocaleString()}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* row 2: selects + toggles */}
      <div className="flex flex-wrap items-center gap-2">
        <Dropdown label="Language" value={language} onChange={(v) => setParam("language", v)}
          options={[{ key: "", label: "Any language" }, ...languages.map((l) => ({ key: l, label: l }))]} />

        <Dropdown label="Sort" value={sort} onChange={(v) => setParam("sort", v)} options={SORTS} />

        <Dropdown label="Min stars" value={minStars} onChange={(v) => setParam("minStars", v)}
          options={[
            { key: "", label: "Any size" },
            { key: "100", label: "100+ ★" },
            { key: "1000", label: "1k+ ★" },
            { key: "10000", label: "10k+ ★" },
          ]} />

        {/* the killer toggle */}
        <button
          onClick={() => setParam("unclaimed", unclaimed ? "" : "1")}
          className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] transition-colors"
          style={{
            border: `1px solid ${unclaimed ? "var(--accent)" : "var(--line)"}`,
            background: unclaimed ? "var(--green-dim)" : "transparent",
            color: unclaimed ? "var(--accent)" : "var(--ink-soft)",
            fontWeight: unclaimed ? 590 : 400,
          }}
          title="Hide issues that are already assigned or have an open PR"
        >
          Unclaimed only
          {counts?.unclaimed != null && (
            <span
              className="rounded-full px-1.5 text-[11px] tabular-nums"
              style={{
                background: unclaimed ? "rgba(0,113,227,0.16)" : "var(--bg-soft)",
                color: unclaimed ? "var(--accent)" : "var(--ink-faint)",
              }}
            >
              {counts.unclaimed.toLocaleString()}
            </span>
          )}
        </button>

        {/* show closed/merged issues too (hidden by default) */}
        <button
          onClick={() => setParam("closed", closed ? "" : "1")}
          className="rounded-full px-3.5 py-1.5 text-[13px] transition-colors"
          style={{
            border: `1px solid ${closed ? "var(--accent)" : "var(--line)"}`,
            background: closed ? "var(--green-dim)" : "transparent",
            color: closed ? "var(--accent)" : "var(--ink-soft)",
            fontWeight: closed ? 590 : 400,
          }}
          title="Include issues that are already closed or merged"
        >
          Show closed
        </button>
      </div>
    </div>
  );
}

function Dropdown({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { key: string; label: string }[];
}) {
  const active = value !== "";
  return (
    <label className="relative inline-flex items-center">
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="cursor-pointer rounded-full py-1.5 pl-3 pr-7 text-[13px] outline-none transition-colors"
        style={{
          border: `1px solid ${active ? "var(--accent)" : "var(--line)"}`,
          background: active ? "var(--green-dim)" : "var(--panel)",
          color: active ? "var(--accent)" : "var(--ink-soft)",
          appearance: "none",
          WebkitAppearance: "none",
        }}
      >
        {options.map((o) => (
          <option key={o.key || label} value={o.key} style={{ background: "var(--panel)", color: "var(--ink)" }}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-3 text-[10px]" style={{ color: "var(--ink-faint)" }}>▾</span>
    </label>
  );
}
