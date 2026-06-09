import { NextRequest, NextResponse } from "next/server";
import type { IssueQuery } from "@/lib/db";
import { getIssues } from "@/lib/issues";

// GET /api/issues?language=Rust&band=green&unclaimed=1&minStars=100&limit=60
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  const q: IssueQuery = {
    language: sp.get("language") || undefined,
    band: (sp.get("band") as IssueQuery["band"]) || undefined,
    unclaimedOnly: sp.get("unclaimed") === "1",
    minStars: sp.get("minStars") ? Number(sp.get("minStars")) : undefined,
    sort: (sp.get("sort") as IssueQuery["sort"]) || undefined,
    limit: sp.get("limit") ? Number(sp.get("limit")) : 60,
  };

  try {
    const rows = await getIssues(q);
    return NextResponse.json({ count: rows.length, issues: rows });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message, hint: "Run `npm run ingest` to populate the cache." },
      { status: 500 }
    );
  }
}
