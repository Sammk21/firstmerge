import { NextResponse, type NextRequest } from "next/server";
import { runIngest, isIngestRunning } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // allow a long-running fetch (honored where supported)

// The shared secret that authorizes an unattended ingest. Vercel Cron sends
// `Authorization: Bearer $CRON_SECRET` automatically when CRON_SECRET is set.
// INGEST_SECRET is accepted too, for manual/curl triggers.
function configuredSecret(): string | null {
  return process.env.CRON_SECRET || process.env.INGEST_SECRET || null;
}

function hasValidBearer(req: NextRequest): boolean {
  const secret = configuredSecret();
  if (!secret) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}`;
}

// Same-origin guard for the dashboard button (a browser fetch with no secret).
function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-CORS / server-side fetch — no Origin header
  const host = req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function trigger(): Promise<NextResponse> {
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

// GET — the Vercel Cron entrypoint (steady-drip, every 10 min). Requires the
// Bearer secret in production; allowed in local dev when no secret is set.
export async function GET(req: NextRequest) {
  const secret = configuredSecret();
  if (secret && !hasValidBearer(req)) {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }
  return trigger();
}

// POST — the dashboard "Fetch latest data" button. Same-origin browser calls
// are allowed; a valid Bearer token also authorizes (e.g. curl/automation).
export async function POST(req: NextRequest) {
  if (!hasValidBearer(req) && !isSameOrigin(req)) {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }
  return trigger();
}
