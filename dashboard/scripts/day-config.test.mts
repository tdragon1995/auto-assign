/**
 * Which config tab governs a date, and what follows from getting it wrong.
 *
 * The workbook has two complete config tabs — the weekday mapping table and
 * "CONFIG SUNDAY" — and `loadConfigFromSheets` returns whichever governs RIGHT
 * NOW. That is correct for the assign cycle, which only dispatches today, and
 * wrong for every question about a leave row, because a leave row carries its
 * own date.
 *
 * The bug that found this: Nguyễn Hoàng Nhân drives Sundays only (sixty rows on
 * the Sunday tab, none on the weekday one). Leave filed for a MONDAY was judged
 * against whatever tab happened to be loaded, so a reconcile running on a
 * Sunday saw him on duty 06:00–08:00 and generated a "Thay ca" for a day he
 * does not work.
 *
 * The quiet half runs the other way: on the other six days a SUNDAY leave is
 * judged against weekday rules, so a real Sunday conflict is never noticed. A
 * fix that only stopped the false row would leave that half in place, which is
 * why the test below asserts both directions.
 *
 *   npx tsx scripts/day-config.test.mts
 */

import { configTabForDate } from "../src/lib/day-config";
import { deriveThayCaRows } from "../src/lib/thay-ca";
import type { Mapping } from "../src/lib/types";

let failures = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}\n         got  ${g}\n         want ${w}`); }
};

// --- which tab governs a date -------------------------------------------------

console.log("picking the tab from the date");
// 2026-09-20 is a Sunday; 09-21 the Monday after it.
eq("a Sunday takes the Sunday tab", configTabForDate("2026-09-20"), "sunday");
eq("the Monday after does not", configTabForDate("2026-09-21"), "mapping");
eq("nor the Saturday before", configTabForDate("2026-09-19"), "mapping");
// Read as UTC, so the answer cannot depend on where the server happens to run —
// a local read would call this Saturday anywhere west of Greenwich.
eq("a date string carries no zone of its own", configTabForDate("2026-09-20"), "sunday");
eq("a year boundary resolves normally", configTabForDate("2027-01-03"), "sunday");
// All but one day in seven is a weekday, so that is the safe fallback.
eq("garbage falls back to the weekday table", configTabForDate("not-a-date"), "mapping");
eq("so does an empty string", configTabForDate(""), "mapping");

// --- and what the choice decides ----------------------------------------------

const hm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return { hours: h, minutes: m };
};
const row = (driver_id: string, start: string, end: string): Mapping => ({
  customer_id: "D014", driver_id, smart_driver_id: [], dropoff_id: "",
  first_name_last_name: "", shift_start: hm(start), shift_end: hm(end),
  bot_token: "", chat_id: "", alt_drop_off_id: "",
});

// NHAN is the Sunday-only driver: on duty 06:00–08:00 on the Sunday tab, absent
// from the weekday one. SON is on leave and NHAN covers for him.
const NHAN = "uuid-nhan";
const weekdayRules: Mapping[] = [row("uuid-someone-else", "06:00", "20:00")];
const sundayRules: Mapping[] = [row(NHAN, "06:00", "08:00")];

const leaveOn = (date: string) => [{
  driver_id: "uuid-son", driver_name: "Sơn",
  leave_from: date, leave_to: date,
  gio_bat_dau: "06:00", gio_ket_thuc: "12:00",
  loai_nghi: "Nghỉ nửa buổi",
  subs: [{ id: NHAN, name: "P - C - PT101808 Nguyễn Hoàng Nhân", from: null, to: null }],
}];

const rulesFor = (date: string) => (configTabForDate(date) === "sunday" ? sundayRules : weekdayRules);

console.log("the Thay ca that should not exist");
// The reported bug, reproduced: judged against the SUNDAY rules — which is what
// a reconcile running on a Sunday used to hand it — Monday's leave generates a
// row for a day the substitute does not work.
eq("judging Monday against Sunday's rules invents one",
  deriveThayCaRows(leaveOn("2026-09-21"), sundayRules).length, 1);
eq("…and judging it against the day's OWN rules does not",
  deriveThayCaRows(leaveOn("2026-09-21"), rulesFor).length, 0);

console.log("the half that was quietly missing");
// The same fault the other way. On any weekday the loaded tab is the weekday
// one, so a genuine Sunday conflict produced nothing at all.
eq("judging Sunday against weekday rules misses a real conflict",
  deriveThayCaRows(leaveOn("2026-09-20"), weekdayRules).length, 0);
eq("…and judging it against the day's OWN rules finds it",
  deriveThayCaRows(leaveOn("2026-09-20"), rulesFor).length, 1);
eq("…with the hours the two actually share",
  deriveThayCaRows(leaveOn("2026-09-20"), rulesFor)
    .map((r) => `${r.leave_from} ${r.leave_from_hr}–${r.leave_to_hr}`),
  ["2026-09-20 06:00–08:00"]);

console.log("a leave spanning both");
// One row, several days, and the days do not agree on which tab applies — the
// case a single mapping set cannot express at all.
const spanning = [{ ...leaveOn("2026-09-19")[0], leave_to: "2026-09-21" }];
eq("each day of a span is judged on its own rules",
  deriveThayCaRows(spanning, rulesFor).map((r) => r.leave_from), ["2026-09-20"]);

console.log("an array still means one rule set for every date");
// The offline tests and every pre-Sunday caller pass an array; that has to keep
// meaning what it always meant.
eq("passing rules directly applies them to all days",
  deriveThayCaRows(spanning, sundayRules).map((r) => r.leave_from),
  ["2026-09-19", "2026-09-20", "2026-09-21"]);

console.log(failures === 0 ? "\nAll passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
