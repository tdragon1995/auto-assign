/**
 * Leave windows and shift windows must read the clock the same way.
 *
 * Why this is worth a test. The two rules were written years apart in different
 * files, and drifted: the config sheet's shift check is half-open — `(start,
 * end]`, outgoing driver owns the boundary minute — while leave rows were
 * inclusive at BOTH ends. On any day where a driver has back-to-back leave
 * (06:00–15:00 then 15:00–19:00), that one-minute difference means two leave
 * rows are live at 15:00 at once and the engine picks between them on subs
 * count, which is a coin toss. It also meant a leave ending at 15:00 still read
 * as on-leave at 15:00 while the substitute covering FROM 15:00 had not opened
 * yet — one minute a day when a fully covered driver reports "Nghỉ, không
 * người thay" and their jobs fail.
 *
 * The drift is invisible for all 1439 other minutes of the day, which is
 * exactly why it survived so long and why a sweep, not a spot check, is what
 * guards it. This asserts agreement at every minute, so the next person to
 * touch either rule cannot move one without the other.
 *
 * Pure arithmetic — no Redis, no network, no sheet:
 *
 *   npx tsx scripts/leave-window-boundary.test.mts
 */

import { inWindow } from "../src/lib/leave-config";
import { isDriverOnShift } from "../src/lib/fixed-driver";
import type { Mapping } from "../src/lib/types";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` — got ${got}, want ${want}`}`);
}

/** A Date whose Saigon wall clock reads `mins` past midnight. VN is UTC+7 and
 *  has no DST, so subtracting 7 hours in UTC is exact. */
function vnClock(mins: number): Date {
  return new Date(Date.UTC(2026, 7, 20, Math.floor(mins / 60) - 7, mins % 60));
}

function shiftMapping(startMins: number, endMins: number): Mapping {
  return {
    customer_id: "TEST",
    driver_id: "d1",
    smart_driver_id: [],
    first_name_last_name: "Test",
    shift_start: { hours: Math.floor(startMins / 60), minutes: startMins % 60 },
    shift_end: { hours: Math.floor(endMins / 60), minutes: endMins % 60 },
    bot_token: "",
    chat_id: "",
    alt_drop_off_id: "",
  };
}

const MORNING: [number, number] = [6 * 60, 15 * 60];  // 06:00–15:00
const AFTERNOON: [number, number] = [15 * 60, 19 * 60]; // 15:00–19:00

console.log("\n1. The boundary minute belongs to the window that ENDS there");
check("14:59 inside 06:00–15:00", inWindow(14 * 60 + 59, ...MORNING), true);
check("15:00 inside 06:00–15:00", inWindow(15 * 60, ...MORNING), true);
check("15:01 inside 06:00–15:00", inWindow(15 * 60 + 1, ...MORNING), false);
check("15:00 inside 15:00–19:00", inWindow(15 * 60, ...AFTERNOON), false);
check("15:01 inside 15:00–19:00", inWindow(15 * 60 + 1, ...AFTERNOON), true);

console.log("\n2. Two adjacent rows never both apply, and never leave a gap");
for (const m of [14 * 60 + 59, 15 * 60, 15 * 60 + 1]) {
  const live = [inWindow(m, ...MORNING), inWindow(m, ...AFTERNOON)].filter(Boolean).length;
  check(`exactly one row live at ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`, live, 1);
}

console.log("\n3. Leave agrees with config at every minute of the day");
let mismatches = 0;
for (const [start, end] of [MORNING, AFTERNOON, [0, 8 * 60], [21 * 60, 24 * 60 - 1]] as [number, number][]) {
  const mapping = shiftMapping(start, end);
  for (let m = 0; m < 1440; m++) {
    if (inWindow(m, start, end) !== isDriverOnShift(mapping, vnClock(m))) mismatches++;
  }
}
check("mismatched minutes across 4 windows x 1440 minutes", mismatches, 0);

console.log(failures === 0 ? "\nPASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
