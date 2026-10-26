/**
 * Resignations: an end date, and cover one date at a time.
 *
 * A resignation used to run forever and take a forever-sub, which outlived the
 * sub's own resignation (Phi → Toán, 10/2026). Now:
 *   - it ends the day before the driver is named as anyone's substitute;
 *   - it is listed on every date the config still gives the driver work
 *     (fixed rule, or the only candidate of a smart one), each date covered by
 *     its own whole-day cover row;
 *   - a cover row counts only while its resignation still covers its date.
 *
 *   npx tsx scripts/resignation-cover.test.mts
 */
import {
  leaveEntriesOnDate, dropStaleResignCovers, holdsRouteOn, resignationOn, findLeaveConflict,
  RESIGN_COVER_NOTE, type LeaveEntry,
} from "../src/lib/leave-config";
import { deriveThayCaRows } from "../src/lib/thay-ca";
import type { Mapping } from "../src/lib/types";

let failures = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}\n         got  ${g}\n         want ${w}`); }
};

const entry = (over: Partial<LeaveEntry>): LeaveEntry => ({
  driver_id: "toan", driver_name: "P - C - PTBU Nguyễn Trần Toán", loai_nghi: "Nghỉ việc",
  leave_from: "2026-10-22", leave_to: null, gio_bat_dau: null, gio_ket_thuc: null, subs: [], ...over,
});
const resign = entry({});
const cover = entry({
  loai_nghi: "Nghỉ nguyên buổi", leave_from: "2026-10-27", leave_to: "2026-10-27", note: RESIGN_COVER_NOTE,
  subs: [{ id: "huy", name: "Kim Thành Tài Huy", from: null, to: null }],
});
const holds = () => true;
const free = () => false;

console.log("an end date");
eq("open resignation covers any later date", resignationOn("toan", "2026-12-01", [resign])?.leave_from, "2026-10-22");
const ended = entry({ leave_to: "2026-10-26" });
eq("an ended one stops at leave_to", resignationOn("toan", "2026-10-27", [ended]), null);
eq("and still covers its last day", resignationOn("toan", "2026-10-26", [ended])?.leave_from, "2026-10-22");
eq("an ended resignation does not block resigning again",
  findLeaveConflict(entry({ leave_from: "2026-11-10" }), [ended]), null);
eq("an open one does",
  findLeaveConflict(entry({ leave_from: "2026-11-10" }), [resign])?.leave_from, "2026-10-22");
eq("nor does an ended one block leave after it",
  findLeaveConflict(entry({ loai_nghi: "Nghỉ nguyên buổi", leave_from: "2026-10-28", leave_to: "2026-10-28" }), [ended]), null);

console.log("which routes need cover");
eq("a fixed rule", holdsRouteOn("toan", [{ driver_id: "toan", smart_driver_id: [] }]), true);
eq("the only smart candidate", holdsRouteOn("toan", [{ driver_id: "", smart_driver_id: ["toan"] }]), true);
eq("one of several smart candidates is not", holdsRouteOn("toan", [{ driver_id: "", smart_driver_id: ["toan", "vu"] }]), false);

console.log("listed date by date");
const d27 = leaveEntriesOnDate("2026-10-27", [resign, cover], holds);
eq("a date with routes lists the resignation once, for that date", d27.map((e) => [e.loai_nghi, e.cover_date]), [["Nghỉ việc", "2026-10-27"]]);
eq("carrying that date's cover", d27[0].subs.map((s) => s.id), ["huy"]);
eq("and the resignation's own start, so delete still finds it", d27[0].leave_from, "2026-10-22");
eq("another date has no cover yet",
  leaveEntriesOnDate("2026-10-28", [resign, cover], holds)[0].subs, []);
eq("no routes, past the transition: not listed", leaveEntriesOnDate("2026-10-28", [resign], free), []);
eq("no routes, on the first day: the transition line, no cover date",
  leaveEntriesOnDate("2026-10-22", [resign], free).map((e) => e.cover_date ?? null), [null]);
eq("without a config answer the old display holds", leaveEntriesOnDate("2026-10-28", [resign]), []);
eq("past the end: not listed even with routes",
  leaveEntriesOnDate("2026-10-27", [ended], holds), []);

console.log("a cover only counts under its resignation");
eq("kept while the resignation covers it", dropStaleResignCovers([resign, cover]).length, 2);
eq("dropped once it has ended", dropStaleResignCovers([ended, cover]).map((e) => e.loai_nghi), ["Nghỉ việc"]);
eq("dropped when the resignation is gone", dropStaleResignCovers([cover]), []);
eq("an ordinary whole day is never touched",
  dropStaleResignCovers([entry({ loai_nghi: "Nghỉ nguyên buổi", note: "Nhập từ dashboard" })]).length, 1);

console.log("Thay ca for the person covering");
const rule = (driver_id: string, start: string, end: string): Mapping => ({
  customer_id: `branch-${driver_id}`, driver_id, smart_driver_id: [], dropoff_id: "", first_name_last_name: driver_id,
  shift_start: { hours: Number(start.slice(0, 2)), minutes: Number(start.slice(3)) },
  shift_end: { hours: Number(end.slice(0, 2)), minutes: Number(end.slice(3)) },
  bot_token: "", chat_id: "", alt_drop_off_id: "",
});
const nhanCover = { ...cover, subs: [{ id: "nhan", name: "Nguyễn Hoàng Nhân", from: null, to: null }] };
const windows = (rules: Mapping[], e = nhanCover) =>
  deriveThayCaRows([e], rules).map((r) => `${r.driver_id} ${r.leave_from_hr}–${r.leave_to_hr}`);
eq("while the resigned driver still holds routes, the sub's own clashing hours are handed over",
  windows([rule("toan", "08:00", "22:00"), rule("nhan", "16:00", "22:00")]), ["nhan 16:00–22:00"]);
eq("once the routes are moved to the sub there is nothing to hand over (Toán → Nhân, 26/10)",
  windows([rule("nhan", "16:00", "22:00")]), []);
eq("ordinary leave of a driver with no rules still reads as all day",
  windows([rule("nhan", "16:00", "22:00")], { ...nhanCover, note: "Nhập từ dashboard" }), ["nhan 16:00–22:00"]);

console.log(failures === 0 ? "\nAll passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
