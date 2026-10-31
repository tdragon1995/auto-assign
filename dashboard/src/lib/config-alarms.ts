import type { SheetAlarm } from "./types";
import { vnTimestamp } from "./time";

// ── Config warnings for the dashboard banner ─────────────────────────────────
//
// Per-instance on purpose, and that is enough: the assign cycle loads the config
// and publishes the snapshot in the SAME invocation, so this map is always the
// view of the instance that just did the loading.
//
// Reported only when it CHANGES (`drainConfigAlarms`), so a healthy fleet writes
// nothing at all — the key-value plan is billed per command.
const warnings = new Map<string, SheetAlarm>();
let changed = false;
// Change-only publishing alone cannot retract an alarm nobody alive is holding
// any more (an instance can only CLEAR what it previously set). So the first
// report from each process is unconditional: it states the truth even when the
// truth is "nothing". One extra write per instance lifetime, not per cycle.
let checked = false;
let publishedOnce = false;

/**
 * Record config CONTENT that is wrong — a lookup that no longer resolves.
 * Keyed by a distinct label per warning so one clearing does not silence another.
 * Pass null to clear.
 */
export function noteConfigWarning(label: string, reason: string | null): void {
  checked = true;
  if (reason) {
    if (warnings.get(label)?.reason === reason) return;   // same complaint, already standing
    warnings.set(label, { kind: "data", label, reason, ts: vnTimestamp() });
    changed = true;
  } else if (warnings.delete(label)) {
    changed = true;
  }
}

/** The current set, or null when nothing has changed since the last drain — the
 *  cycle then leaves the published field untouched rather than rewriting it. */
export function drainConfigAlarms(): SheetAlarm[] | null {
  // Gated on having actually looked, so an instance that has not loaded the
  // config yet cannot publish an empty set over a real one.
  const firstReport = checked && !publishedOnce;
  if (!changed && !firstReport) return null;
  changed = false;
  publishedOnce = true;
  return [...warnings.values()];
}
