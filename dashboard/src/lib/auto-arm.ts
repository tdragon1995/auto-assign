import { vnDate, vnMinutesSinceMidnight, vnTimestamp, parseVnTimestamp } from "./time";
import {
  getLastDisarm,
  setArmState,
  clearDisarmAlert,
  pushRunLog,
  type ArmState,
} from "./smart-log-kv";

// The engine should be ON every day across this window. It auto-offs at the end
// (22:00) and auto-ons at the start (05:30) — no manual morning arming needed.
// End is exclusive so the 22:00 auto-off is never immediately re-armed.
export const WINDOW_START_MIN = 5 * 60 + 30; // 05:30
export const WINDOW_END_MIN = 22 * 60;       // 22:00

const AUTO_OFF_HHMMSS = "22:00:00";

// A disarm newer than this counts as "just happened" — the anomaly we react to.
// Older off-states (overnight, never-armed-this-morning) are routine: auto-arm
// silently, no alert. Also the grace given to an in-progress env/mode switch.
const FRESH_DISARM_MS = 10 * 60 * 1000;

export function inAutoArmWindow(d: Date = new Date()): boolean {
  const m = vnMinutesSinceMidnight(d);
  return m >= WINDOW_START_MIN && m < WINDOW_END_MIN;
}

/** Epoch ms of the next 22:00 VN auto-off (today's if still ahead, else tomorrow's). */
export function nextAutoOffMs(): number {
  const todayOff = parseVnTimestamp(`${vnDate()} ${AUTO_OFF_HHMMSS}`).getTime();
  if (Date.now() < todayOff) return todayOff;
  const tomorrow = vnDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
  return parseVnTimestamp(`${tomorrow} ${AUTO_OFF_HHMMSS}`).getTime();
}

export interface AutoArmResult {
  state: ArmState;  // the freshly-armed state — caller runs a cycle with it
  alert: boolean;   // true when a fresh manual disarm should be emailed
}

/**
 * Called when the cron finds the engine OFF. Inside the 05:30–22:00 window the
 * engine should be running, so self-heal by arming it (prod / smart, armedBy
 * "auto"). Returns null to leave it off:
 *   - outside the window (overnight — auto-off is intended), or
 *   - during the short grace after an env switch (a reasoned disarm), so we
 *     don't fight the operator finishing their re-arm.
 * `alert` is true only for a fresh *bare* manual disarm — someone deliberately
 * turned a running engine off during the window. An overnight/never-armed off is
 * routine and arms silently.
 */
export async function autoArmIfDue(): Promise<AutoArmResult | null> {
  if (!inAutoArmWindow()) return null;

  const rec = await getLastDisarm();
  const ageMs = rec ? Date.now() - new Date(rec.ts).getTime() : Infinity;
  const isFresh = ageMs < FRESH_DISARM_MS;

  // Leave an in-progress env switch alone briefly; it self-heals once stale.
  if (rec?.reason && isFresh) return null;

  const alert = !!rec && !rec.reason && isFresh;

  const state: ArmState = {
    armedUntil: nextAutoOffMs(),
    armedTs: new Date().toISOString(),
    armedBy: "auto",
    env: "prod",
  };
  await setArmState(state);
  // Clear the debounce so the *next* manual disarm alerts again (each disarm →
  // its own email, since the engine is re-armed between them).
  await clearDisarmAlert().catch(() => {});

  // Visible trace in the activity log: routine morning arm is OK; self-healing
  // a fresh manual off is a WARN naming who had turned it off.
  void pushRunLog([{
    ts: vnTimestamp(),
    level: alert ? "WARN" : "OK",
    msg: alert
      ? `🟠 ENGINE AUTO-ARMED — was turned off by ${rec?.by || "?"} during business hours`
      : "🟢 ENGINE AUTO-ARMED (05:30–22:00 window)",
  }]).catch(() => {});

  return { state, alert };
}
