import { NextResponse } from "next/server";
import { getArmState, getCronHeartbeat, getRunLog, getHeldJobs } from "@/lib/smart-log-kv";

/**
 * One poll for the whole dashboard: switch state, heartbeat, live log, and the
 * note-held list — so the tab makes a single request instead of three.
 */
export async function GET() {
  const [state, lastChecked, logs, held] = await Promise.all([
    getArmState(),
    getCronHeartbeat(),
    getRunLog(100),
    getHeldJobs(),
  ]);
  return NextResponse.json({ armed: !!state, state, lastChecked, logs, held });
}
