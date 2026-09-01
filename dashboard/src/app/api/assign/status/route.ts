import { NextRequest, NextResponse } from "next/server";
import { getStatusBundle, statusPayload } from "@/lib/smart-log-kv";

/**
 * One poll for the whole dashboard: switch state, heartbeat, live log, and the
 * note-held list — single pipeline request to Upstash instead of 4 separate calls.
 *
 * `?since=<ts>` returns only log entries with ts >= since, so the steady-state
 * 90s poll ships a few new lines instead of re-sending the same 100 entries.
 * Inclusive (>=) so same-second entries aren't lost; the client dedupes the
 * boundary second. Without `since`, the full window is returned (first load).
 */
export async function GET(req: NextRequest) {
  // Shaped by statusPayload rather than here, so the "every field the bundle
  // computes reaches the dashboard" rule is one testable function instead of a
  // list to keep in step. It has fallen out of step three times.
  return NextResponse.json(
    statusPayload(await getStatusBundle(100), req.nextUrl.searchParams.get("since")),
  );
}
