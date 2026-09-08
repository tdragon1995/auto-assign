/**
 * The rostered-schedule reader.
 *
 * Why this is worth a test. The reader's whole job is to answer one question —
 * "what was this driver scheduled to work" — and the dangerous answer is not a
 * wrong time, it is a confident "nothing". Measured against the live workbook on
 * 2026-09-06, only 45 of the 82 active part-time accounts appear in the schedule
 * at all, and the schedule spans a rolling two months. So for roughly half the
 * fleet, and for every month older than the window, the honest answer is "we do
 * not know" — and if that ever collapses into "not scheduled", anything built on
 * top of it starts producing confident wrong numbers about somebody's wage.
 *
 * Section 1 is therefore the load-bearing one: unknown ≠ off.
 *
 *   npx tsx scripts/shift-window.test.mts
 */
import {
  shiftDayForCode, shiftDayForDriver, coversDate, windowMinutes,
  type ShiftIndex, type ShiftRow,
} from "../src/lib/shift-window";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const row = (p: Partial<ShiftRow> & { employee_code: string; date: string }): ShiftRow => ({
  full_name: "Nguyễn Văn A",
  start: null,
  end: null,
  leave_start: null,
  leave_end: null,
  leave_gap: false,
  ...p,
});

function index(rows: ShiftRow[], roster: [string, string][] = []): ShiftIndex {
  const byCodeDate = new Map<string, ShiftRow>();
  for (const r of rows) byCodeDate.set(`${r.employee_code}|${r.date}`, r);
  const dates = rows.map((r) => r.date).sort();
  return {
    byCodeDate,
    codeByDriverId: new Map(roster),
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    degraded: false,
  };
}

// A small schedule: one PT driver working, one rostered off, one on a half day.
const IDX = index(
  [
    row({ employee_code: "PT100001", date: "2026-09-01", start: "06:00", end: "15:00" }),
    row({ employee_code: "PT100001", date: "2026-09-02" }),
    row({
      employee_code: "PT100002", date: "2026-09-01", start: "06:00", end: "15:00",
      leave_start: "12:00", leave_end: "15:00",
    }),
    row({ employee_code: "PT100003", date: "2026-09-01", leave_gap: true }),
  ],
  [["uuid-1", "PT100001"], ["uuid-2", "PT100002"], ["uuid-no-code", ""]],
);

// ── 1. unknown is not off ───────────────────────────────────────────────────
console.log("unknown ≠ off");
{
  // A driver with no row at all: the ~37 active PT accounts with no pattern.
  const d = shiftDayForCode(IDX, "PT109999", "2026-09-01");
  check("a driver with no pattern is unknown, not off", d.kind === "unknown", d.kind);
  check("and says why", d.kind === "unknown" && d.reason === "no-row");
}
{
  // A date outside the rolling window: last July, asked for in October.
  const d = shiftDayForCode(IDX, "PT100001", "2026-07-14");
  check("a date the sheet does not cover is unknown, not off", d.kind === "unknown", d.kind);
  check("coversDate says so once, for the whole day", !coversDate(IDX, "2026-07-14"));
  check("and is true inside the window", coversDate(IDX, "2026-09-01"));
}
{
  // A rostered non-working day IS off — the schedule positively says so.
  const d = shiftDayForCode(IDX, "PT100001", "2026-09-02");
  check("a rostered blank day is off, not unknown", d.kind === "off", d.kind);
}
{
  // The whole tab failed to load. Every answer must be unknown, and must NOT
  // look like a fleet that is simply not working today.
  const broken: ShiftIndex = { ...IDX, byCodeDate: new Map(), degraded: true };
  const d = shiftDayForCode(broken, "PT100001", "2026-09-01");
  check("a failed load answers unknown", d.kind === "unknown", d.kind);
  check("and distinguishes itself from a missing row",
    d.kind === "unknown" && d.reason === "unavailable", d.kind === "unknown" ? d.reason : "");
}

// ── 2. The Cartrack uuid join ───────────────────────────────────────────────
console.log("\nthe driver-id join");
{
  const d = shiftDayForDriver(IDX, "uuid-1", "2026-09-01");
  check("a known uuid resolves to its schedule", d.kind === "scheduled", d.kind);
  check("with the rostered window", d.kind === "scheduled" && d.start === "06:00" && d.end === "15:00");
}
{
  // A blank employee_code cell and a missing pattern row are fixed in different
  // places, so they are reported as different reasons rather than one shrug.
  const d = shiftDayForDriver(IDX, "uuid-unknown", "2026-09-01");
  check("an unmapped uuid is unknown", d.kind === "unknown", d.kind);
  check("named as a roster problem, not a pattern one",
    d.kind === "unknown" && d.reason === "no-employee-code", d.kind === "unknown" ? d.reason : "");
}

// ── 3. What the day carries ─────────────────────────────────────────────────
console.log("\nleave windows and flags");
{
  const d = shiftDayForCode(IDX, "PT100002", "2026-09-01");
  // The half day is the reason this reader prefers the flat tab over the month
  // grid, which compresses this whole case into the single letter "P".
  check("a half day keeps its leave window",
    d.kind === "scheduled" && d.leave_start === "12:00" && d.leave_end === "15:00");
  check("and is still a scheduled day, not an off one", d.kind === "scheduled", d.kind);
}
{
  const d = shiftDayForCode(IDX, "PT100003", "2026-09-01");
  check("leave_gap survives to the caller", d.kind === "off" && d.leave_gap === true);
}

// ── 4. Window arithmetic ────────────────────────────────────────────────────
console.log("\nwindowMinutes");
check("a normal shift", windowMinutes("06:00", "15:00") === 540, String(windowMinutes("06:00", "15:00")));
check("a short evening tap", windowMinutes("19:00", "19:30") === 30);
// Not a night shift: this schedule has no way to express one, so a backwards
// window is bad data. Answering 0 would price it; answering null asks about it.
check("a backwards window is null, not zero", windowMinutes("19:00", "06:00") === null);
check("an unparseable time is null", windowMinutes("6h", "15:00") === null);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
