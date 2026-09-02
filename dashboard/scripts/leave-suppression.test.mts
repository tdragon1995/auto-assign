/**
 * A leave row deleted on purpose must stay deleted — and nothing else must.
 *
 * Deleting a row settles nothing on its own: the MISA pusher re-derives every
 * charged day from today forward on each run and dedupes purely on the row being
 * present, so a partly-approved request is un-deleted at the next 04:45 sync.
 * The "Nghỉ phép đã xoá" tab is what closes that, and a suppression list is a
 * dangerous thing to own — it is a standing instruction to ignore what the
 * system of record says, and its natural failure is outliving the reason for it.
 *
 * So this pins the narrowness as hard as the blocking:
 *
 *   - EXACT on driver + day + window. Two half-days on one date are two rows;
 *     deleting the morning one must not silence the afternoon.
 *   - a suppression for one driver never touches their twin, or anyone else who
 *     happens to be off the same day.
 *   - `liveSuppressions` drops days already past, because the pusher floors its
 *     range at today and a line that can no longer block anything must not sit
 *     in the panel looking like it can.
 *
 * The automated-only scoping — a person's submission is never blocked — lives in
 * the route, not here, because it is a decision about the CALLER rather than
 * about the match.
 *
 * Pure logic — no sheet, no network:
 *
 *   npx tsx scripts/leave-suppression.test.mts
 */

import {
  findSuppression, liveSuppressions, windowKey, type LeaveSuppression,
} from "../src/lib/leave-suppression";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (label: string, got: unknown, want: unknown) =>
  check(label, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const SON = "id-son-dc";
const SON_PT = "id-son-pt";

function supp(o: Partial<LeaveSuppression>): LeaveSuppression {
  return {
    driver_id: SON,
    driver_name: "F - C - DC100777 Nguyễn Hồng Sơn",
    loai_nghi: "Nghỉ nguyên buổi",
    leave_from: "2026-09-10",
    leave_to: "2026-09-10",
    gio_bat_dau: null,
    gio_ket_thuc: null,
    deleted_at: "2026-09-02 09:30:00",
    note: "MISA auto 2026-09-01 04:45",
    ...o,
  };
}
function cand(o: Partial<Parameters<typeof findSuppression>[0]> = {}) {
  return {
    driver_id: SON,
    leave_from: "2026-09-10",
    leave_to: "2026-09-10",
    gio_bat_dau: null,
    gio_ket_thuc: null,
    ...o,
  };
}

// ── Blocking the re-push ────────────────────────────────────────────────────
console.log("blocking a day that was deliberately removed");
check("the same full day is blocked", findSuppression(cand(), [supp({})]) !== null);
check("an empty list blocks nothing", findSuppression(cand(), []) === null);
check("another day is untouched", findSuppression(cand({ leave_from: "2026-09-11", leave_to: "2026-09-11" }), [supp({})]) === null);

// ── Never the wrong person ──────────────────────────────────────────────────
console.log("never reaching past the driver it was filed for");
check("another driver off the same day is untouched",
  findSuppression(cand({ driver_id: "id-someone-else" }), [supp({})]) === null);
check("the PT twin is a different account, so a different suppression",
  findSuppression(cand({ driver_id: SON_PT }), [supp({})]) === null);
check("…and deleting the twin's row does not free the full-timer's",
  findSuppression(cand(), [supp({ driver_id: SON_PT })]) === null);

// ── Never the wrong window ──────────────────────────────────────────────────
console.log("never reaching past the window it was filed for");
{
  const morning = supp({ loai_nghi: "Nghỉ nửa buổi", gio_bat_dau: "06:00", gio_ket_thuc: "12:00" });
  check("the morning half-day is blocked",
    findSuppression(cand({ gio_bat_dau: "06:00", gio_ket_thuc: "12:00" }), [morning]) !== null);
  check("the AFTERNOON half-day of the same date is NOT",
    findSuppression(cand({ gio_bat_dau: "12:00", gio_ket_thuc: "18:00" }), [morning]) === null);
  check("nor is the whole day",
    findSuppression(cand(), [morning]) === null);
  check("a full-day suppression does not block a half-day",
    findSuppression(cand({ gio_bat_dau: "12:00", gio_ket_thuc: "18:00" }), [supp({})]) === null);
  check("6:00 and 06:00 are the same window",
    findSuppression(cand({ gio_bat_dau: "06:00", gio_ket_thuc: "12:00" }),
      [supp({ gio_bat_dau: "6:00", gio_ket_thuc: "12:00" })]) !== null);
  eq("a blank pair is the whole day", windowKey(null, null), "full");
  eq("so is a backwards one", windowKey("18:00", "12:00"), "full");
}

// ── Dates, ranges and formats ───────────────────────────────────────────────
console.log("dates, ranges and the sheet's formatting");
// The stored side is normalised by the loader; the candidate side is normalised
// here, so a caller that ever hands over a locale-formatted date still matches.
check("a d/m/yyyy candidate date still matches a stored ISO one",
  findSuppression(cand({ leave_from: "10/9/2026", leave_to: "10/9/2026" }), [supp({})]) !== null);
check("a multi-day suppression covers each day in it",
  findSuppression(cand({ leave_from: "2026-09-11", leave_to: "2026-09-11" }),
    [supp({ leave_from: "2026-09-10", leave_to: "2026-09-12" })]) !== null);
check("…but not the day after it ends",
  findSuppression(cand({ leave_from: "2026-09-13", leave_to: "2026-09-13" }),
    [supp({ leave_from: "2026-09-10", leave_to: "2026-09-12" })]) === null);
check("a multi-day CANDIDATE is blocked if any of its days is",
  findSuppression(cand({ leave_from: "2026-09-09", leave_to: "2026-09-11" }), [supp({})]) !== null);
check("a candidate with no driver_id matches nothing",
  findSuppression(cand({ driver_id: "" }), [supp({})]) === null);
check("a blank leave_to reads as a single day",
  findSuppression(cand(), [supp({ leave_to: null })]) !== null);

// ── What the panel is allowed to show ───────────────────────────────────────
console.log("only the lines that can still block something");
{
  const list = [
    supp({ leave_from: "2026-08-01", leave_to: "2026-08-01" }), // past
    supp({ leave_from: "2026-09-02", leave_to: "2026-09-02" }), // today
    supp({ leave_from: "2026-09-20", leave_to: "2026-09-20" }), // future
  ];
  eq("a day already past is dropped — the pusher never re-derives it",
    liveSuppressions(list, "2026-09-02").map((s) => s.leave_from),
    ["2026-09-02", "2026-09-20"]);
  eq("and they come back in date order",
    liveSuppressions([list[2], list[1]], "2026-09-02").map((s) => s.leave_from),
    ["2026-09-02", "2026-09-20"]);
  eq("a spanning line survives until its LAST day passes",
    liveSuppressions([supp({ leave_from: "2026-08-30", leave_to: "2026-09-05" })], "2026-09-02").length, 1);
}

console.log(failures === 0 ? "\nAll leave-suppression checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
