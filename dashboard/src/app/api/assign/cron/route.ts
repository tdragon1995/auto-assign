import { NextRequest, NextResponse, after } from "next/server";
import { runArmedCycle } from "@/lib/run-cycle";
import {
  getArmState,
  acquireCycleLock,
  releaseCycleLock,
  setCronHeartbeat,
} from "@/lib/smart-log-kv";
import { autoArmIfDue } from "@/lib/auto-arm";
import { maybeAlertHeldOff } from "@/lib/disarm-alert";
import { archiveSealedDays } from "@/lib/tat-archive";

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

  // Driver TAT: seal yesterday into Supabase. Registered HERE — before the arm
  // check — on purpose, so it still runs on the overnight pings that return
  // "disarmed" a line below. Those pings do almost nothing, which makes them the
  // cheapest moment of the day to spend on a day-fetch, and by then the day being
  // sealed is genuinely finished.
  //
  // Redis-gated to once per day per date (archiveSealedDays), so this is a no-op
  // on all but one ping. In after(), and internally non-throwing, so a reporting
  // failure can never delay or break an assign cycle.
  after(async () => {
    const res = await archiveSealedDays().catch(() => null);
    if (res) console.log("[cron] TAT seal:", JSON.stringify(res));
  });

  // 1) Switch off? Inside 05:30–22:00 the engine should be running, so self-heal
  //    by auto-arming — unless someone turned it off by hand, which now holds
  //    until they turn it back on. A held engine emails a daily reminder instead.
  //    Outside the window (overnight) we leave it off.
  let arm = await getArmState();
  if (!arm) {
    const auto = await autoArmIfDue();
    if (!auto) {
      return NextResponse.json({ ran: false, skipped: "disarmed" });
    }
    if (auto.kind === "held") {
      after(() => maybeAlertHeldOff().catch(() => {}));
      return NextResponse.json({ ran: false, skipped: "held-off", by: auto.hold.by });
    }
    arm = auto.state; // freshly auto-armed — fall through and run a cycle now
  }

  // 2) One cycle at a time — skip if a previous ping (or the arm-time first run)
  //    is still running.
  const gotLock = await acquireCycleLock();
  if (!gotLock) {
    return NextResponse.json({ ran: false, skipped: "locked" });
  }

  // Respond immediately so cron-job.org (30s max) doesn't time out.
  // The cycle continues in after() for up to maxDuration (60s).
  after(async () => {
    try {
      await runArmedCycle(arm);
    } catch (e) {
      console.error("[cron] runArmedCycle failed:", e);
    } finally {
      await releaseCycleLock().catch(() => {});
    }
  });

  return NextResponse.json({ ran: true, env: arm.env });
}
