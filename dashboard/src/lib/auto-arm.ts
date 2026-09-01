import { vnDate, vnMinutesSinceMidnight, vnTimestamp, parseVnTimestamp } from "./time";
import {
  getLastDisarm,
  getArmHold,
  setArmState,
  clearDisarmAlert,
  pushRunLog,
  type ArmState,
  type ArmHold,
} from "./smart-log-kv";

// The engine should be ON every day across this window. It auto-offs at the end
// (22:00) and auto-ons at the start (05:30) — no manual morning arming needed.
// End is exclusive so the 22:00 auto-off is never immediately re-armed.
export const WINDOW_START_MIN = 5 * 60 + 30; // 05:30
export const WINDOW_END_MIN = 22 * 60;       // 22:00

const AUTO_OFF_HHMMSS = "22:00:00";

// A reasoned disarm (env switch) newer than this is treated as in-progress: the
// operator is mid-switch and about to re-arm, so auto-arm keeps its hands off.
// Older off-states (overnight, never-armed-this-morning) are routine.
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

export type AutoArmOutcome =
  /** Freshly armed — the caller runs a cycle with this state. */
  | { kind: "armed"; state: ArmState }
  /** Someone turned the switch off: it stays off, and the caller says so. */
  | { kind: "held"; hold: ArmHold };

/**
 * Called when the cron finds the engine OFF. Inside the 05:30–22:00 window the
 * engine should normally be running, so self-heal by arming it (prod / smart,
 * armedBy "auto") — UNLESS a human turned it off.
 *
 * A manual off leaves a hold that has no expiry, so it outlives every ping and
 * every day boundary; only pressing the switch on clears it. That is the whole
 * point: the switch used to un-flip itself within three minutes of being used.
 *
 * Returns null to leave the engine off with nothing to report:
 *   - outside the window (overnight — the auto-off is intended), or
 *   - during the short grace after an env switch, so we don't fight the operator
 *     finishing their re-arm (that disarm self-heals once stale).
 */
export async function autoArmIfDue(): Promise<AutoArmOutcome | null> {
  if (!inAutoArmWindow()) return null;

  // Checked first — a held engine needs no other read.
  const hold = await getArmHold();
  if (hold) return { kind: "held", hold };

  const rec = await getLastDisarm();
  const ageMs = rec ? Date.now() - new Date(rec.ts).getTime() : Infinity;

  // Leave an in-progress env switch alone briefly; it self-heals once stale.
  if (rec?.reason && ageMs < FRESH_DISARM_MS) return null;

  const state: ArmState = {
    armedUntil: nextAutoOffMs(),
    armedTs: new Date().toISOString(),
    armedBy: "auto",
    env: "prod",
  };
  await setArmState(state);
  // Clear the debounce so the *next* off-during-hours alerts again.
  await clearDisarmAlert().catch(() => {});

  void pushRunLog([{
    ts: vnTimestamp(),
    level: "OK",
    msg: "🟢 ENGINE AUTO-ARMED (05:30–22:00 window)",
  }]).catch(() => {});

  return { kind: "armed", state };
}
