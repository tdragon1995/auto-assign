import { NextRequest, NextResponse, after } from "next/server";
import {
  getArmState,
  setArmState,
  clearArmState,
  getCronHeartbeat,
  acquireCycleLock,
  releaseCycleLock,
  setLastDisarm,
  clearDisarmAlert,
  pushRunLog,
  type ArmState,
} from "@/lib/smart-log-kv";
import { runArmedCycle } from "@/lib/run-cycle";
import { nextAutoOffMs } from "@/lib/auto-arm";
import { vnTimestamp } from "@/lib/time";

// Headroom for the immediate first cycle kicked off after arming.
export const maxDuration = 60;

// Manual arm always succeeds and runs until the next 22:00 VN auto-off (shared
// with the cron's auto-arm). The engine also auto-arms across 05:30–22:00, so a
// manual arm is mainly for arming early, switching env/mode, or after a manual off.

/** Current switch state + last cron heartbeat. */
export async function GET() {
  const [state, lastChecked] = await Promise.all([getArmState(), getCronHeartbeat()]);
  return NextResponse.json({ armed: !!state, state, lastChecked });
}

/** Turn the switch ON until the next 22:00 VN auto-off. */
export async function POST(req: NextRequest) {
  let body: { env?: string; mode?: string; by?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — defaults applied below */
  }

  const armedUntil = nextAutoOffMs();

  const state: ArmState = {
    armedUntil,
    armedTs: new Date().toISOString(),
    armedBy: (body.by ?? "").trim().slice(0, 60),
    env: body.env === "uat" ? "uat" : "prod",
    mode: body.mode === "autoplan" ? "autoplan" : "smart",
  };

  await setArmState(state);
  // Re-arming ends the disarm episode — reset the alert debounce so the next
  // off-during-hours event emails again.
  await clearDisarmAlert().catch(() => {});
  // Make on/off events visible in the activity log — the Jun 11 midday outage
  // was invisible precisely because disarms left no trace here.
  void pushRunLog([{
    ts: vnTimestamp(),
    level: "OK",
    msg: `🟢 ENGINE ARMED by ${state.armedBy || "?"} (${state.mode}, ${state.env})`,
  }]).catch(() => {});

  // Kick off the first cycle right away (after the response) so we don't wait
  // for the next cron ping. Lock-guarded so it can't overlap a cron cycle.
  after(async () => {
    try {
      const gotLock = await acquireCycleLock();
      if (!gotLock) return; // a cron cycle is already running — it covers the first run
      try {
        await runArmedCycle(state, req.nextUrl.origin);
      } finally {
        await releaseCycleLock().catch(() => {});
      }
    } catch {
      /* first-run is best-effort; the next cron ping will run a full cycle */
    }
  });

  return NextResponse.json({ armed: true, state });
}

/** Turn the switch OFF immediately. `?by=` records the operator and `?reason=`
 *  distinguishes a manual off from an auto-disarm (env/mode switch), so the
 *  business-hours alert can name who turned it off. */
export async function DELETE(req: NextRequest) {
  await clearArmState();
  const by = (req.nextUrl.searchParams.get("by") ?? "").trim();
  const reason = (req.nextUrl.searchParams.get("reason") ?? "").trim();
  await setLastDisarm(by, reason || undefined).catch(() => {});
  void pushRunLog([{
    ts: vnTimestamp(),
    level: "WARN",
    msg: `🔴 ENGINE DISARMED by ${by || "?"}${reason ? ` — ${reason}` : ""}`,
  }]).catch(() => {});
  return NextResponse.json({ armed: false, state: null });
}
