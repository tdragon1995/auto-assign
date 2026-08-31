/**
 * A leave write must never be waved through by a sheet nobody could read.
 *
 * On 30/08 a column on the Nghỉ phép tab was renamed, so the tab was refused by
 * its header contract on every load. The duplicate check read the empty list
 * that a refused load returns, concluded there was nothing to clash with, and
 * let the MISA sync append the same eight rows on all 21 of its runs that day —
 * 160 identical rows for one day off, and a "trùng dòng" flag on every driver
 * who had it.
 *
 * Nothing about the clash RULE was wrong: replayed against the live sheet it
 * correctly calls those rows a duplicate. The hole was that the rule was being
 * asked a question about data that was not there, and answered "no clash",
 * which is the same answer as "go ahead and write". So the two failures this
 * pins are:
 *
 *   1. an unreadable sheet is distinguishable from an empty one, and the write
 *      path gets an exception rather than a plausible-looking empty list;
 *   2. a row whose driver link went blank still blocks a duplicate of itself,
 *      by its typed name — because a renamed driver blanks that link on every
 *      row at once, which is exactly when re-pushes start duplicating.
 *
 * Pure logic — no Redis, no network, no sheet:
 *
 *   npx tsx scripts/leave-write-guard.test.mts
 */

import { findLeaveConflict, type LeaveEntry, type InvalidLeaveRow } from "../src/lib/leave-config";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.error(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
}

const DRIVER_ID = "4894b938-7295-11f0-b247-506b8d982279";
const DRIVER = "F - P - DC101204 Phạm Thế Luật";

/** What the MISA sync submits for one charged full day off. */
const candidate: LeaveEntry = {
  driver_id: DRIVER_ID, driver_name: DRIVER, loai_nghi: "Nghỉ nguyên buổi",
  leave_from: "2026-08-31", leave_to: "2026-08-31",
  gio_bat_dau: null, gio_ket_thuc: null, subs: [],
};
/** The row its previous run already wrote. */
const onSheet: LeaveEntry = { ...candidate };

// ── The rule itself, which was never the problem ──────────────────────────────
check("a second push of the same day off clashes",
  findLeaveConflict(candidate, [onSheet]) !== null, true);

// ── 1. What an unreadable sheet looked like to the old write path ─────────────
// This is the exact call the route used to make after clearing its own cache:
// nothing to compare against, so nothing to object to. Left as a statement of
// why an empty list must never reach this function from a writer.
check("an empty list cannot object to anything",
  findLeaveConflict(candidate, []), null);

// ── 2. A row whose driver link went blank still blocks its own duplicate ──────
// The id column is a lookup on the typed name: rename the driver and every row
// for them loses its id at once. Those rows are dropped from the entry list, so
// an id comparison cannot see them — and a re-push would duplicate a day off
// that is plainly already recorded.
const orphan: InvalidLeaveRow = {
  driver_name: DRIVER, loai_nghi: "Nghỉ nguyên buổi",
  leave_from: "2026-08-31", leave_to: "2026-08-31",
  timeLabel: null, hasSub: false, recovered: false,
};
check("an orphaned row blocks a duplicate of itself",
  findLeaveConflict(candidate, [], [orphan]) !== null, true);

// A windowed orphan keeps its hours, so an adjacent shift is still allowed
// through: the boundary minute belongs to the outgoing row, same as everywhere.
const morningOrphan: InvalidLeaveRow = { ...orphan, loai_nghi: "Nghỉ nửa buổi", timeLabel: "06:00–12:00" };
const afternoon: LeaveEntry = { ...candidate, loai_nghi: "Nghỉ nửa buổi", gio_bat_dau: "12:00", gio_ket_thuc: "20:00" };
const morningAgain: LeaveEntry = { ...candidate, loai_nghi: "Nghỉ nửa buổi", gio_bat_dau: "06:00", gio_ket_thuc: "12:00" };
check("an orphaned morning does not block the afternoon",
  findLeaveConflict(afternoon, [], [morningOrphan]), null);
check("an orphaned morning does block the same morning",
  findLeaveConflict(morningAgain, [], [morningOrphan]) !== null, true);

// Names are matched EXACTLY, never loosely: about a dozen drivers hold a PT and
// a DC account under one personal name, and blocking the wrong account's leave
// off a bare-name match would be worse than the duplicate it prevents.
const otherAccount: InvalidLeaveRow = { ...orphan, driver_name: "P - P - PT101280 Phạm Thế Luật" };
check("the same person's other account is not the same driver",
  findLeaveConflict(candidate, [], [otherAccount]), null);

// A different day is not a clash — re-pushing a month must still add new days.
check("a different day off still goes through",
  findLeaveConflict({ ...candidate, leave_from: "2026-09-01", leave_to: "2026-09-01" }, [onSheet], [orphan]), null);

console.log(failures === 0 ? "\nall good" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
