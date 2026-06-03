import { NextResponse } from "next/server";
import { getStatusBundle } from "@/lib/smart-log-kv";

/**
 * One poll for the whole dashboard: switch state, heartbeat, live log, and the
 * note-held list — single pipeline request to Upstash instead of 4 separate calls.
 */
export async function GET() {
  const { state, lastChecked, logs, held } = await getStatusBundle(100);
  return NextResponse.json({ armed: !!state, state, lastChecked, logs, held });
}
