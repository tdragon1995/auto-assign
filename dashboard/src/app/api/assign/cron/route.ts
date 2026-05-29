import { NextRequest, NextResponse } from "next/server";
import { runArmedCycle } from "@/lib/run-cycle";
import {
  getArmState,
  acquireCycleLock,
  releaseCycleLock,
  setCronHeartbeat,
} from "@/lib/smart-log-kv";

// The cycle (Cartrack + Goong calls) can take a while; give it headroom.
export const maxDuration = 60;

/** Reject unless the caller presents the shared secret. If CRON_SECRET is unset,
 *  the endpoint stays open (same exposure as /api/assign today). */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization");
  const header = req.headers.get("x-cron-secret");
  return auth === `Bearer ${secret}` || header === secret;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Liveness: record every authorized ping so the dashboard can show the system
  // is alive even when nothing gets logged.
  await setCronHeartbeat().catch(() => {});

  // 1) Is the switch on? Disarmed pings must stop here — cheap, no Sheet/Cartrack.
  const arm = await getArmState();
  if (!arm) {
    return NextResponse.json({ ran: false, skipped: "disarmed" });
  }

  // 2) One cycle at a time — skip if a previous ping (or the arm-time first run)
  //    is still running.
  const gotLock = await acquireCycleLock();
  if (!gotLock) {
    return NextResponse.json({ ran: false, skipped: "locked" });
  }

  try {
    const logs = await runArmedCycle(arm, req.nextUrl.origin);
    const counts = {
      ok: logs.filter((l) => l.level === "OK").length,
      warn: logs.filter((l) => l.level === "WARN").length,
      error: logs.filter((l) => l.level === "ERROR").length,
    };
    return NextResponse.json({ ran: true, mode: arm.mode, env: arm.env, counts, entries: logs.length });
  } catch (e) {
    return NextResponse.json({ ran: false, error: String(e) }, { status: 500 });
  } finally {
    await releaseCycleLock().catch(() => {});
  }
}
