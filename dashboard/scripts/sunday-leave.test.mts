/**
 * The Sunday roster cross-checked against leave.
 *
 * The two sheets are maintained by different people at different times — ops
 * types the Sunday roster a week ahead, leave arrives afterwards from MISA or
 * the panel — so the interesting cases are all about NOT crying wolf and NOT
 * staying silent:
 *
 *   1. The date. The roster tab writes "dd/MM/yyyy" and every leave function
 *      speaks "YYYY-MM-DD". A wrong or defaulted date makes the leave lookup
 *      answer "nobody is off" with complete confidence, which is the one wrong
 *      answer this feature must never give — so an unparseable date turns the
 *      check OFF rather than guessing a day.
 *   2. The twin. About a dozen people hold both a PT and a DC account under one
 *      personal name. The roster cell carries the staff code, which is what
 *      resolves them; a cell without one that matches both is reported for
 *      repair, never resolved to whichever came first.
 *   3. The half day. A 06:00–10:00 absence against an afternoon shift is a
 *      person who is there when the roster needs them. Overlap is compared by
 *      the HOUR, like `companionNeeded`, because both sides are hand-typed.
 *
 *   npx tsx scripts/sunday-leave.test.mts
 */

import { sundayDateToIso, caWindow, leaveFlagFor } from "../src/lib/sunday-leave.ts";
import type { LeaveOnDate } from "../src/lib/leave-config.ts";

let failures = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label} — got ${g}, want ${w}`); }
};

const roster = [
  { driver_id: "id-dc-thao", name: "F - C - DC100320 Đoàn Văn Thảo" },
  { driver_id: "id-pt-thao", name: "P - C - PT101225 Đoàn Văn Thảo" },
  { driver_id: "id-hung",    name: "F - C - DC100001 Lý Chánh Hùng" },
];

const leave = (o: Partial<LeaveOnDate> & { driver_id: string }): LeaveOnDate => ({
  driver_name: "",
  loai_nghi: "Nghỉ nguyên buổi",
  leave_from: "2026-09-20",
  timeLabel: null,
  subs: [],
  duplicate: false,
  ...o,
});

console.log("reading the roster tab's date");
eq("dd/MM/yyyy becomes an ISO day", sundayDateToIso("20/09/2026"), "2026-09-20");
eq("single digits are padded", sundayDateToIso("7/9/2026"), "2026-09-07");
eq("a blank is refused, not defaulted", sundayDateToIso(""), null);
eq("prose is refused", sundayDateToIso("Chủ Nhật"), null);
eq("an impossible month is refused", sundayDateToIso("20/13/2026"), null);

console.log("\nreading the shift column");
eq("an en dash splits", caWindow("07:00 – 15:00"), { from: 420, to: 900 });
eq("a hyphen splits too", caWindow("07:00-15:00"), { from: 420, to: 900 });
eq("bare hours count", caWindow("7h - 15h"), { from: 420, to: 900 });
eq("an unreadable shift is null, so the day alone decides", caWindow("cả ngày"), null);

console.log("\nflagging a rostered name");
eq("a whole-day absence is flagged",
  leaveFlagFor("DC100001 Lý Chánh Hùng", "07:00 - 15:00", roster,
    [leave({ driver_id: "id-hung" })]),
  { status: "leave", timeLabel: null, loaiNghi: "Nghỉ nguyên buổi", subs: [] });

eq("someone else's leave says nothing",
  leaveFlagFor("DC100001 Lý Chánh Hùng", "07:00 - 15:00", roster,
    [leave({ driver_id: "id-dc-thao" })]),
  null);

eq("an unfilled slot is never flagged",
  leaveFlagFor("", "07:00 - 15:00", roster, [leave({ driver_id: "id-hung" })]), null);

console.log("\nthe twin");
eq("the staff code picks the PT account, not the DC one",
  leaveFlagFor("PT101225 Đoàn Văn Thảo", "07:00 - 15:00", roster,
    [leave({ driver_id: "id-pt-thao" })])?.status,
  "leave");
eq("the DC twin's leave does not answer for the PT account",
  leaveFlagFor("PT101225 Đoàn Văn Thảo", "07:00 - 15:00", roster,
    [leave({ driver_id: "id-dc-thao" })]),
  null);
eq("a bare name matching both is reported, never resolved",
  leaveFlagFor("Đoàn Văn Thảo", "07:00 - 15:00", roster,
    [leave({ driver_id: "id-dc-thao" })]),
  { status: "unmatched", timeLabel: null, loaiNghi: "", subs: [] });

console.log("\nthe half day");
eq("a morning absence does not flag an afternoon shift",
  leaveFlagFor("DC100001 Lý Chánh Hùng", "15:00 - 20:00", roster,
    [leave({ driver_id: "id-hung", loai_nghi: "Nghỉ nửa buổi", timeLabel: "06:00–10:00" })]),
  null);
eq("a morning absence DOES flag a morning shift",
  leaveFlagFor("DC100001 Lý Chánh Hùng", "07:00 - 15:00", roster,
    [leave({ driver_id: "id-hung", loai_nghi: "Nghỉ nửa buổi", timeLabel: "06:00–10:00" })])?.status,
  "leave");
// Shared boundary: "off until 15:00" against a shift starting 15:00. Flagged,
// on purpose — an absence ending exactly where a shift begins is worth a glance,
// and both numbers are typed by hand so neither is precise enough to bet on.
eq("an absence ending where the shift starts still flags",
  leaveFlagFor("DC100001 Lý Chánh Hùng", "15:00 - 20:00", roster,
    [leave({ driver_id: "id-hung", loai_nghi: "Nghỉ nửa buổi", timeLabel: "06:00–15:00" })])?.status,
  "leave");
// And the converse: the hours are floored on both sides, so an absence that
// ends inside the hour BEFORE the shift does not reach it.
eq("an absence ending the hour before does not",
  leaveFlagFor("DC100001 Lý Chánh Hùng", "15:00 - 20:00", roster,
    [leave({ driver_id: "id-hung", loai_nghi: "Nghỉ nửa buổi", timeLabel: "06:00–14:30" })]),
  null);
eq("an unreadable shift falls back to the day, so the flag still shows",
  leaveFlagFor("DC100001 Lý Chánh Hùng", "cả ngày", roster,
    [leave({ driver_id: "id-hung", loai_nghi: "Nghỉ nửa buổi", timeLabel: "06:00–10:00" })])?.status,
  "leave");

console.log("\nthe substitute");
eq("a named substitute rides along, so the shift reads as handed over",
  leaveFlagFor("DC100001 Lý Chánh Hùng", "07:00 - 15:00", roster,
    [leave({ driver_id: "id-hung", subs: [{ id: "x", name: "Trần Ánh", from: null, to: null }] })])?.subs,
  ["Trần Ánh"]);

console.log("\nthe roster failing to load");
eq("an empty roster says nothing rather than condemning every name",
  leaveFlagFor("DC100001 Lý Chánh Hùng", "07:00 - 15:00", [],
    [leave({ driver_id: "id-hung" })]),
  null);

console.log(failures === 0 ? "\nAll sunday-leave checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
