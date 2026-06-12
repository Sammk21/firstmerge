import { NextRequest } from "next/server";
import { parseIssueQuery } from "@/lib/db";
import { getIssues } from "@/lib/issues";

// GET /api/feed — Atom feed of issues, honoring the same filters as the
// homepage and /api/issues (language, band, unclaimed, minStars, sort, limit).
// Contributors subscribe to e.g. /api/feed?band=green&unclaimed=1&language=Rust
// and get new mergeable issues in their reader. Reads go through the same
// cache as the homepage, so this adds no extra DB load.

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const BAND_LABEL = { green: "likely to merge", yellow: "mixed", red: "risky" } as const;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = parseIssueQuery((k) => sp.get(k));

  let issues;
  try {
    issues = await getIssues(q);
  } catch {
    return new Response("Feed unavailable — database not seeded yet.", { status: 503 });
  }

  const origin = req.nextUrl.origin;
  const self = `${origin}/api/feed${req.nextUrl.search}`;
  const filterDesc = [
    q.band && `${q.band} band`,
    q.language,
    q.unclaimedOnly && "unclaimed",
    q.minStars && `${q.minStars}+ stars`,
  ]
    .filter(Boolean)
    .join(", ");

  const updated =
    issues
      .map((i) => i.fetched_at)
      .sort()
      .at(-1) ?? new Date().toISOString();

  const entries = issues
    .map((i) => {
      const date = i.created_at ?? i.fetched_at;
      const summary = `Merge Score ${i.merge_score}/100 (${BAND_LABEL[i.score_band]}) · ${
        i.repo_full
      }${i.stars != null ? ` · ★${i.stars}` : ""} · ${i.comments} comments`;
      return `  <entry>
    <id>${esc(i.url)}</id>
    <title>[${i.merge_score}] ${esc(i.title)} (${esc(i.repo_full)})</title>
    <link href="${esc(i.url)}"/>
    <updated>${esc(date ?? updated)}</updated>
    <summary>${esc(summary)}</summary>
  </entry>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${esc(self)}</id>
  <title>FirstMerge — good first issues${filterDesc ? ` (${esc(filterDesc)})` : ""}</title>
  <subtitle>Good first issues that actually get merged</subtitle>
  <link href="${esc(self)}" rel="self"/>
  <link href="${esc(origin)}"/>
  <updated>${esc(updated)}</updated>
${entries}
</feed>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/atom+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
