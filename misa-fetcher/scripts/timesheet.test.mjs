// Run: node scripts/timesheet.test.mjs (no network).
import assert from "node:assert/strict";
import { pickTimesheets, parseTimesheetShifts } from "../lib/parse.mjs";

const T = (id, from, to, org = "40286", sum = 1) => ({ TimeSheetID: id, FromDate: `${from}T00:00:00.000+07:00`, ToDate: `${to}T00:00:00.000+07:00`, OrganizationUnitID: org, IsUseBySummary: sum });
const list = [
  T(11103, "2026-09-15", "2026-10-14"), T(11102, "2026-09-01", "2026-09-30", "40286", null),
  T(11096, "2026-08-15", "2026-09-14"), T(11099, "2026-07-01", "2026-07-31", "40306,40307,40308"),
  T(11050, "2025-05-15", "2025-06-14", "40286", null), T(11042, "2025-05-15", "2025-06-14"),
];
assert.deepEqual(pickTimesheets(list, "2026-09-01", "2026-11-30").map((t) => t.id), [11103, 11096], "15th sheets only, company-wide");
assert.deepEqual(pickTimesheets(list, "2025-05-01", "2025-05-31").map((t) => t.id), [11042], "duplicate period: the summarised one");

const day = (o) => JSON.stringify([o]);
const shift = { StartTime: "08:00:00", EndTime: "17:00:00", WorkingShiftCode: "08001700" };
const rows = [{
  EmployeeCode: "DC102114", FullName: "Ngô Minh Quang",
  Day1: day(shift), Day6: "[]", Day8: day({ ...shift, TotalLeave: 1 }),
  Day26: day({ IsTerminationDate: true }), Day31: null,
}];
const recs = parseTimesheetShifts(rows, "2026-09-15", { "DC102114|2026-09-22": { start: "08:00", end: "17:00" } });
const at = (d) => recs.find((r) => r.shift_date === d);
assert.equal(at("2026-09-15").start_time, "08:00");
assert.equal(at("2026-09-15").end_time, "17:00");
assert.equal(at("2026-09-20").day_type, "off", "empty day = off");
assert.equal(at("2026-09-22").day_type, "working", "a leave day keeps its shift (a cover needs it)");
assert.equal(at("2026-09-22").leave_start, "08:00");
assert.equal(at("2026-10-10"), undefined, "nothing after resignation");
assert.equal(recs.length, 3);
console.log("timesheet: ok");
