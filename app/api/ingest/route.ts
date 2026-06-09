import { NextResponse } from "next/server";
import { runIngest, isIngestRunning } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // allow a long-running fetch (honored on platforms that support it)

// POST /api/ingest — triggered by the dashboard "Fetch latest data" button.
export async function POST() {
  if (isIngestRunning()) {
    return NextResponse.json({ ok: false, message: "An ingest is already running." }, { status: 409 });
  }
  try {
    const summary = await runIngest();
    return NextResponse.json(summary, { status: summary.ok ? 200 : 502 });
  } catch (err) {
    return NextResponse.json({ ok: false, message: (err as Error).message }, { status: 500 });
  }
}

// GET — lightweight status so the UI can tell if one is mid-flight.
export function GET() {
  return NextResponse.json({ running: isIngestRunning() });
}
