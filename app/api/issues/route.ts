import { NextRequest, NextResponse } from "next/server";
import { parseIssueQuery } from "@/lib/db";
import { getIssues } from "@/lib/issues";

// GET /api/issues?language=Rust&band=green&unclaimed=1&minStars=100&sort=newest&limit=60
// Params are validated by parseIssueQuery (shared with the homepage): unknown
// band/sort values are ignored, limit is clamped, numbers are sanitized.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = parseIssueQuery((k) => sp.get(k));

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
