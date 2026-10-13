// Run from dashboard: npx tsx scripts/shift-grid.test.mts (no network).
import assert from "node:assert/strict";
import { cellStatus, periodMonthOf } from "../src/lib/shift-grid";

const plan = [{ start: "16:00", end: "20:00" }];
const base = { plan, actualIn: null as string | null, actualOut: null as string | null, wholeDayLeave: false, dayOff: false, approved: false, past: true };

assert.equal(cellStatus({ ...base, actualIn: "15:58", actualOut: "20:03" }), "ok", "on time both ends");
assert.equal(cellStatus({ ...base, actualIn: "16:10", actualOut: "19:50" }), "ok", "within 15 minutes is still đủ");
assert.equal(cellStatus({ ...base, actualIn: "16:40", actualOut: "20:00" }), "short", "late in");
assert.equal(cellStatus({ ...base, actualIn: "16:00", actualOut: "19:20" }), "short", "early out");
assert.equal(cellStatus({ ...base, actualIn: "16:00", actualOut: null }), "short", "no end = not shown as đủ");
assert.equal(cellStatus({ ...base, plan: [], actualIn: "07:00", actualOut: "15:00" }), "noshift", "worked with no shift");
assert.equal(cellStatus({ ...base }), "absent", "a past shift with nothing");
assert.equal(cellStatus({ ...base, past: false }), "", "a future shift is not absent");
assert.equal(cellStatus({ ...base, wholeDayLeave: true }), "leave");
assert.equal(cellStatus({ ...base, wholeDayLeave: true, actualIn: "16:00", actualOut: "20:00" }), "ok", "worked through leave shows what happened");
assert.equal(cellStatus({ ...base, plan: [], dayOff: true }), "off");
assert.equal(cellStatus({ ...base, plan: [], approved: true }), "approved", "an approved correction wins");
assert.equal(cellStatus({ ...base, plan: [{ start: "06:00", end: "12:00" }, { start: "15:00", end: "20:00" }], actualIn: "06:00", actualOut: "20:00" }), "ok", "split day: first start, last end");

assert.equal(periodMonthOf("2026-10-13"), "2026-10");
assert.equal(periodMonthOf("2026-10-15"), "2026-11");
assert.equal(periodMonthOf("2026-12-20"), "2027-01");
console.log("shift-grid: ok");
