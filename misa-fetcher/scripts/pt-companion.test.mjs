/**
 * The part-time twin of a MISA leave day.
 *
 * A dozen or so people hold two Cartrack accounts under one personal name: the
 * full-time `DC…` record MISA pays their leave against, and the part-time `PT…`
 * one they switch to for a trip running past their shift. MISA names only the
 * first, so a day off used to leave the second reading as available all evening.
 *
 * Two things this pins, and they pull in opposite directions:
 *
 *   1. the twin is only ever taken when the name says exactly one account —
 *      inventing a day off on the wrong record takes a WORKING driver off the
 *      road, which is worse than the gap being closed;
 *   2. an afternoon half-day carries to the END OF THE DAY on the twin, not the
 *      MISA window. Mirroring 12:00–18:00 would leave 18:00–22:00 open, which is
 *      the only stretch the twin account is ever used for — the feature would
 *      look like it worked and do nothing.
 *
 * Pure logic — no MISA, no network, no sheet:
 *
 *   node scripts/pt-companion.test.mjs
 */

import {
  personName,
  isPartTime,
  findPtTwin,
  buildPtCompanion,
  buildLeaveSubmissions,
  PT_SWITCH_MIN,
} from "../lib/leave-push.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (label, got, want) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// A roster shaped like the real Driver tab.
const SON_FT = { driver_id: "id-son-dc", label: "F - C - DC100777 Nguyễn Hồng Sơn", employee_code: "DC100777", active: true };
const SON_PT = { driver_id: "id-son-pt", label: "P - P - PT101147 Nguyễn Hồng Sơn", employee_code: "PT101147", active: true };
const HUNG_FT = { driver_id: "id-hung", label: "F - C - DC100320 Lý Chánh Hùng", employee_code: "DC100320", active: true };
const THAO_PT = { driver_id: "id-thao", label: "P - P - PT101225 Đoàn Văn Thảo", employee_code: "PT101225", active: true };
const THAO_FT = { driver_id: "id-thao-dc", label: "F - C - DC101225 Đoàn Văn Thảo", employee_code: "DC101225", active: true };
const THAO_PT2 = { driver_id: "id-thao-pt2", label: "P - P - PT109999 Đoàn Văn Thảo", employee_code: "PT109999", active: true };
const GONE_PT = { driver_id: "id-gone", label: "P - P - PT100001 Lý Chánh Hùng", employee_code: "PT100001", active: false };

const ROSTER = [SON_FT, SON_PT, HUNG_FT, THAO_PT, THAO_FT, GONE_PT];

// ── Reading a label ─────────────────────────────────────────────────────────
console.log("reading a driver label");
eq("the code and the prefix come off", personName(SON_FT.label), "nguyen hong son");
eq("both accounts reduce to the same person", personName(SON_PT.label), personName(SON_FT.label));
eq("đ is a letter, not a mark", personName("P - P - PT101225 Đoàn Văn Thảo"), "doan van thao");
eq("a label with no code survives whole", personName("Admin Lý Thị Thùy Linh"), "admin ly thi thuy linh");
check("PT code ⇒ part-time", isPartTime(SON_PT.label));
check("DC code ⇒ not part-time", !isPartTime(SON_FT.label));
check("a codeless P-prefixed label still reads part-time", isPartTime("P - P - Nguyễn Văn A"));
check("a Vietnamese name starting with P is not a code", !isPartTime("Phạm Thế Luật"));

// ── Finding the twin ────────────────────────────────────────────────────────
console.log("finding the part-time twin");
eq("the one PT account with the same name", findPtTwin(SON_FT, ROSTER).twin?.driver_id, "id-son-pt");
eq("nobody to find is not an error", findPtTwin(HUNG_FT, ROSTER).reason, "none");
check("a DEACTIVATED twin is never used", findPtTwin(HUNG_FT, ROSTER).twin === null);
eq("leave already on a PT account gets no twin", findPtTwin(SON_PT, ROSTER).reason, "already-pt");
eq(
  "two PT accounts under one name are left alone",
  findPtTwin(THAO_FT, [...ROSTER, THAO_PT2]).reason,
  "ambiguous",
);
check("…and produce nothing", findPtTwin(THAO_FT, [...ROSTER, THAO_PT2]).twin === null);

// ── The companion row ───────────────────────────────────────────────────────
console.log("building the companion row");
const day = (over) => ({
  driver_id: SON_FT.driver_id,
  driver_name: SON_FT.label,
  employee_code: "DC100777",
  date: "2026-09-04",
  loai_nghi: "nguyen_buoi",
  ngay_bat_dau: "2026-09-04",
  ngay_ket_thuc: "2026-09-04",
  gio_bat_dau: null,
  gio_ket_thuc: null,
  leave_type: "Nghỉ phép",
  ...over,
});

const full = buildPtCompanion(day(), SON_PT);
eq("a full day off names the twin", full.driver_id, "id-son-pt");
eq("…with the twin's sheet label", full.driver_name, SON_PT.label);
eq("…still a full day", [full.loai_nghi, full.gio_bat_dau, full.gio_ket_thuc], ["nguyen_buoi", null, null]);
eq("…on the same date", [full.ngay_bat_dau, full.ngay_ket_thuc], ["2026-09-04", "2026-09-04"]);
check("…and is marked as derived", full.pt_companion === true);

const afternoon = buildPtCompanion(
  day({ loai_nghi: "nua_buoi", gio_bat_dau: "12:00", gio_ket_thuc: "18:00" }),
  SON_PT,
);
eq("an afternoon half-day starts when the person leaves", afternoon.gio_bat_dau, "12:00");
eq("…and runs to the end of the day, NOT the MISA window", afternoon.gio_ket_thuc, "23:59");

const straddling = buildPtCompanion(
  day({ loai_nghi: "nua_buoi", gio_bat_dau: "10:00", gio_ket_thuc: "14:00" }),
  SON_PT,
);
eq("a window crossing noon counts as afternoon", straddling?.gio_ket_thuc, "23:59");
eq("…from its own start, not from noon", straddling?.gio_bat_dau, "10:00");

check(
  "a morning half-day leaves the twin alone",
  buildPtCompanion(day({ loai_nghi: "nua_buoi", gio_bat_dau: "06:00", gio_ket_thuc: "12:00" }), SON_PT) === null,
);
check(
  "a half-day with no window is left alone (the engine ignores it too)",
  buildPtCompanion(day({ loai_nghi: "nua_buoi", gio_bat_dau: null, gio_ket_thuc: null }), SON_PT) === null,
);
check(
  "a half-day whose window is backwards is left alone",
  buildPtCompanion(day({ loai_nghi: "nua_buoi", gio_bat_dau: "18:00", gio_ket_thuc: "12:00" }), SON_PT) === null,
);
eq("noon is the switch", PT_SWITCH_MIN, 720);

// ── End to end, through the attendance parser ───────────────────────────────
console.log("through buildLeaveSubmissions");
const range = { monthStart: "2026-09-01", monthEnd: "2026-09-30" };
const byCode = new Map([["DC100777", SON_FT], ["DC100320", HUNG_FT]]);
const attendance = [
  {
    EmployeeCode: "DC100777",
    FullName: "Nguyễn Hồng Sơn",
    AttendanceTypeName: "Nghỉ phép",
    FromDate: "2026-09-04T13:00:00",
    ToDate: "2026-09-04T18:00:00",
    AttendanceData: JSON.stringify([{ Date: "2026-09-04T00:00:00", NumberOfDay: "0.5" }]),
  },
  {
    EmployeeCode: "DC100320",
    FullName: "Lý Chánh Hùng",
    AttendanceTypeName: "Nghỉ phép",
    FromDate: "2026-09-04T00:00:00",
    ToDate: "2026-09-04T00:00:00",
    AttendanceData: JSON.stringify([{ Date: "2026-09-04T00:00:00", NumberOfDay: "1" }]),
  },
];

const withRoster = buildLeaveSubmissions(attendance, byCode, range, {
  minDate: "2026-09-01",
  roster: ROSTER,
});
eq("three rows: two people, one of them twinned", withRoster.submissions.length, 3);
eq(
  "the twin's row is the afternoon one, to end of day",
  withRoster.submissions
    .filter((s) => s.pt_companion)
    .map((s) => [s.driver_name, s.gio_bat_dau, s.gio_ket_thuc]),
  [[SON_PT.label, "13:00", "23:59"]],
);
check(
  "the driver with no twin gets exactly one row",
  withRoster.submissions.filter((s) => s.driver_id === HUNG_FT.driver_id).length === 1,
);

const noRoster = buildLeaveSubmissions(attendance, byCode, range, { minDate: "2026-09-01" });
eq("without a roster the behaviour is exactly what it was", noRoster.submissions.length, 2);
check("…and nothing is marked derived", noRoster.submissions.every((s) => !s.pt_companion));

const thaoOff = [
  {
    EmployeeCode: "DC101225",
    FullName: "Đoàn Văn Thảo",
    AttendanceTypeName: "Nghỉ phép",
    FromDate: "2026-09-04T00:00:00",
    ToDate: "2026-09-04T00:00:00",
    AttendanceData: JSON.stringify([{ Date: "2026-09-04T00:00:00", NumberOfDay: "1" }]),
  },
];
const ambiguous = buildLeaveSubmissions(thaoOff, new Map([["DC101225", THAO_FT]]), range, {
  minDate: "2026-09-01",
  roster: [...ROSTER, THAO_PT2],
});
eq("an ambiguous twin adds no row", ambiguous.submissions.filter((s) => s.pt_companion).length, 0);
eq("…only the full-time row is written", ambiguous.submissions.length, 1);
eq("…and the person is named for a human to look at", [...ambiguous.ptUnresolved.keys()], ["DC101225"]);

console.log(failures === 0 ? "\nAll PT-companion checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
