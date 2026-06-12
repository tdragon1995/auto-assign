import { NextRequest, NextResponse } from "next/server";
import { getStatusBundle } from "@/lib/smart-log-kv";

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
  const { state, lastChecked, logs, held, warnings } = await getStatusBundle(100);
  const since = req.nextUrl.searchParams.get("since");
  const outLogs = since ? logs.filter((l) => l.ts >= since) : logs;
  return NextResponse.json({ armed: !!state, state, lastChecked, logs: outLogs, held, warnings });
}
