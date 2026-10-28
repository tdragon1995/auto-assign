/**
 * Which Sunday lines are OPEN, and what the bot says about them.
 *
 * The Friday post, the roster picture and the "Nhận ca" button all read
 * `isOpen` / `openLines`, so a wrong answer here posts a slot nobody can take,
 * or hides one somebody could. A line is open when nobody is on it, or when
 * its driver will not drive those hours: resigned, or on leave with no
 * substitute where the leave meets the shift.
 *
 *   npx tsx scripts/sunday-roster-post.test.mts
 */

import {
  awayFor, displayArea, displayShift, hoursMeet, isMorning, isOpen, openLines, shiftRange,
  weeklyPostText, claimText, adminAlertText, stageFor, pscAddresses, type PostLine,
} from "../src/lib/sunday-roster-post";

let failures = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};
const line = (p: Partial<PostLine>): PostLine => ({ id: 1, area: "D022", shift: "06:00 - 15:00", note: "", driver_id: null, name: "", ...p });

console.log("reading a shift");
eq("hh:mm - hh:mm", shiftRange("06:00 - 15:00"), [360, 900]);
eq("a one-digit hour, as typed for D032", shiftRange("8:00 - 12:00"), [480, 720]);
eq("the leave panel's en-dash window", shiftRange("13:00–17:00"), [780, 1020]);
eq("blank is unreadable", shiftRange(""), null);
eq("08:00 starts the morning", isMorning("08:00 - 15:00"), true);
eq("15:00 starts the afternoon", isMorning("15:00 - 20:00"), false);

console.log("hours meeting");
eq("overlap", hoursMeet("06:00 - 15:00", "13:00–17:00"), true);
eq("a shared boundary does not count", hoursMeet("06:00 - 15:00", "15:00 - 20:00"), false);
eq("a whole-day leave meets everything", hoursMeet("15:00 - 20:00", null), true);

console.log("is the driver away");
const leave = (window: string | null, covered = false) => ({ resigned: false, window, covered, label: "Nghỉ phép" });
eq("whole-day leave, no sub → away", awayFor("06:00 - 15:00", [leave(null)]), "Nghỉ phép");
eq("a substitute already covers it → not away", awayFor("06:00 - 15:00", [leave(null, true)]), null);
eq("morning half-day does not open the evening line", awayFor("15:00 - 20:00", [leave("06:00–12:00")]), null);
eq("afternoon half-day opens the evening line", awayFor("15:00 - 20:00", [leave("13:00–23:59")]), "Nghỉ phép");
eq("resigned is away whatever the hours", awayFor("15:00 - 20:00", [{ resigned: true, window: null, covered: false, label: "Nghỉ việc từ 20/10" }]), "Nghỉ việc từ 20/10");
eq("no leave → not away", awayFor("06:00 - 15:00", []), null);

console.log("area names as drivers read them");
eq("Phòng khám → PK, bars → commas", displayArea("Phòng khám Q2 | Bình Thạnh ca 2"), "PK Q2, Bình Thạnh ca 2");
eq("unspaced bars too", displayArea("D001 (Phòng khám Q1|3|4|5|10) ca 1"), "D001 (PK Q1, 3, 4, 5, 10) ca 1");
eq("a plain branch is untouched", displayArea("D022"), "D022");
eq("mid-name", displayArea("Hub D003 + Phòng khám Phú Nhuận"), "Hub D003 + PK Phú Nhuận");

console.log("times line up");
eq("one-digit hours get a zero", displayShift("8:00 - 12:00"), "08:00 - 12:00");
eq("both ends", displayShift("6:00 - 9:30"), "06:00 - 09:30");
eq("two-digit hours untouched", displayShift("06:00 - 15:00"), "06:00 - 15:00");
eq("blank stays blank", displayShift(""), "");

console.log("open lines");
eq("nobody on it", isOpen(line({})), true);
eq("someone on it", isOpen(line({ name: "Nam", driver_id: "x" })), false);
eq("someone away", isOpen(line({ name: "Nam", driver_id: "x", away: "Nghỉ phép" })), true);
const week = [
  line({ id: 1, area: "D022" }),
  line({ id: 2, area: "D001 ca 1", name: "Nam", driver_id: "a" }),
  line({ id: 3, area: "Phòng khám Q2 | Bình Thạnh ca 2", shift: "15:00 - 20:00", name: "Hùng", driver_id: "b", away: "Nghỉ phép" }),
  line({ id: 4, area: "BO Runner D001" }),
];
eq("internal roles are never offered", openLines(week).map((l) => l.id), [1, 3]);

console.log("what the bot says");
console.log("draft on Wednesday, final from Friday");
eq("Wednesday before the Sunday is the draft", stageFor("2026-10-28", "2026-11-01"), "draft");
eq("Thursday is still the draft", stageFor("2026-10-29", "2026-11-01"), "draft");
eq("Friday is the final", stageFor("2026-10-30", "2026-11-01"), "final");
eq("so is the Sunday itself", stageFor("2026-11-01", "2026-11-01"), "final");
const draft = weeklyPostText("2026-10-25", week, "draft");
eq("the draft says dự kiến and when the final comes", draft.startsWith("Team gửi lịch làm việc chủ nhật dự kiến ngày 25/10/2026 (lịch chính thức gửi lúc 13:00 thứ Sáu)"), true);
const post = weeklyPostText("2026-10-25", week, "final");
eq("the final says chính thức", post.startsWith("Team gửi lịch làm việc chủ nhật chính thức ngày 25/10/2026\n"), true);
eq("no @All in either", (draft + post).includes("@All"), false);
eq("points at the open-slots picture", post.includes('(xem hình "Ca còn trống")'), true);
eq("counts two digits, as before", post.includes("Hiện đang trống 02 vị trí"), true);
eq("lists an empty slot with its hours", post.includes("D022\t06:00 - 15:00\n"), true);
eq("marks the leave-opened slot, by its short name", post.includes("PK Q2, Bình Thạnh ca 2\t15:00 - 20:00 (cần người thay)"), true);
eq("never names who is on leave", post.includes("Hùng"), false);
eq("keeps the B1–B3 leave steps", post.includes("B3: Thường xuyên kiểm tra"), true);
eq("fits one Zalo message", post.length <= 2000, true);
eq("a full roster says so", weeklyPostText("2026-10-25", [week[1]]).includes("đã đủ người"), true);

const after = [week[1], line({ id: 5, area: "D022", name: "Lan", driver_id: "c" }), week[2]];
const claim = claimText("2026-10-25", "Lan", week[0], after);
eq("claim names who took what", claim.startsWith("✅ Lan đã nhận ca D022 06:00 - 15:00 — Chủ nhật 25/10."), true);
eq("and what is left", claim.includes("Còn 01 vị trí trống"), true);
eq("the last claim closes the week", claimText("2026-10-25", "Lan", week[0], [week[1]]).includes("đã đủ người"), true);

eq("Saturday alert lists what is open", adminAlertText("2026-10-25", week)?.includes("còn 02 vị trí"), true);
eq("and stays quiet when nothing is", adminAlertText("2026-10-25", [week[1]]), null);
eq("says which post comes next", adminAlertText("2026-10-25", week, "draft")?.startsWith("⚠️ Lịch CN 25/10 còn 02 vị trí chưa có người — bản dự kiến gửi tài xế lúc 13:00 thứ Tư:"), true);
eq("Thursday's points at Friday's final", adminAlertText("2026-10-25", week, "final")?.includes("bản chính thức gửi tài xế lúc 13:00 thứ Sáu"), true);

console.log("PSC addresses under an area");
eq("one PSC", pscAddresses("D007 ca 1").length, 1);
eq("two PSCs, in order", pscAddresses("D029 + D046").map((a) => a.split(" ")[0]), ["101", "227A"]);
eq("no code, no address", pscAddresses("Q2/Bình Thạnh"), []);
eq("not inside a longer number", pscAddresses("D0071"), []);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall passed");
