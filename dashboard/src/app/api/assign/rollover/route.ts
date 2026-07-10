import { NextRequest, NextResponse } from "next/server";
import { rolloverUnfinishedJobs } from "@/lib/assign";
import { getJobsByStatusAndDate, type Env } from "@/lib/cartrack";
import { pushRunLog } from "@/lib/smart-log-kv";
import { vnDate, vnTimestamp, vnMinutesSinceMidnight } from "@/lib/time";
import type { LogEntry, LogLevel } from "@/lib/types";

export const maxDuration = 60;

/**
 * Night rollover — cron-pinged at 23:30 VN, AFTER the engine's 22:00 disarm,
 * so it deliberately bypasses the armed switch. THE end-of-day sweep: bump
 * today's still-unassigned ad-hoc client jobs to tomorrow's window, so they're
 * already tomorrow's jobs before anyone plans the morning and the 05:30 cycle
 * assigns them like any other job. Anything created after this ping (or a
 * night it never fires) is caught by the cycle's once-per-day morning pass.
 */

// Hard floor: never act before the engine's 22:00 disarm. Guards against a
// mis-scheduled ping — classic AM/PM mix-up — bumping today's ACTIVE jobs to
// tomorrow in the middle of the working day.
const NIGHT_FLOOR_MINUTES = 22 * 60;

/** Reject unless the caller presents the shared secret. If CRON_SECRET is unset,
 *  the endpoint stays open (same exposure as /api/assign/cron). */
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

  const nowMin = vnMinutesSinceMidnight();
  if (nowMin < NIGHT_FLOOR_MINUTES) {
    return NextResponse.json({ ran: false, skipped: "outside-window", vn_minutes: nowMin });
  }

  const env: Env = req.nextUrl.searchParams.get("env") === "uat" ? "uat" : "prod";
  const logs: LogEntry[] = [];
  const log = (msg: string, level: LogLevel = "INFO") =>
    logs.push({ ts: vnTimestamp(), level, msg });

  try {
    const today = vnDate();
    const tomorrow = vnDate(new Date(Date.now() + 86_400_000));
    const s2 = await getJobsByStatusAndDate(2, today, env);
    const bumped = await rolloverUnfinishedJobs(s2, tomorrow, env, log);
    await pushRunLog(logs).catch((e) => console.error("[rollover] pushRunLog failed:", e));
    return NextResponse.json({
      ran: true,
      env,
      unassigned_today: s2.length,
      rolled_over: [...bumped],
    });
  } catch (e) {
    log(`Night rollover failed: ${e}`, "ERROR");
    await pushRunLog(logs).catch(() => {});
    return NextResponse.json({ ran: false, error: String(e) }, { status: 500 });
  }
}
