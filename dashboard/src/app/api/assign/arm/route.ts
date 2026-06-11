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
  type ArmState,
} from "@/lib/smart-log-kv";
import { runArmedCycle } from "@/lib/run-cycle";
import { vnDate, parseVnTimestamp } from "@/lib/time";

// Headroom for the immediate first cycle kicked off after arming.
export const maxDuration = 60;

// The switch auto-disarms at 22:00 Asia/Ho_Chi_Minh. Arming always succeeds:
// before 22:00 → armed until today's 22:00; after 22:00 → armed until the NEXT
// day's 22:00 (so you can turn it on late; it just runs until tomorrow's
// auto-off). Turn it off manually anytime.
const AUTO_OFF_HHMMSS = "22:00:00";

function nextAutoOffMs(): number {
  const todayOff = parseVnTimestamp(`${vnDate()} ${AUTO_OFF_HHMMSS}`).getTime();
  if (Date.now() < todayOff) return todayOff;
  const tomorrow = vnDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
  return parseVnTimestamp(`${tomorrow} ${AUTO_OFF_HHMMSS}`).getTime();
}

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
  return NextResponse.json({ armed: false, state: null });
}
