/**
 * Pins the config line written for a branch that has none.
 *
 * The two things worth pinning: the suggested window must actually COVER the job
 * that caused it (shift windows are half-open, so the obvious rounding is wrong
 * on the hour), and the row must never carry a value for the four id columns —
 * writing into one of those collapses a spilling ARRAYFORMULA and takes out every
 * branch id in the table at once.
 *
 *   npx tsx scripts/unmapped-row.test.mts
 */

import type { UnmappedBranch } from "../src/lib/unmapped-row";
const { shiftWindowForJob, configCellsFor, dedupeBranches } = await import("../src/lib/unmapped-row");
const { isDriverOnShift } = await import("../src/lib/fixed-driver");

let failed = 0;
const section = (s: string) => console.log(`\n${s}`);
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) return console.log(`  ok   ${label}`);
  failed++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
}
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);

/** A VN wall-clock time as the Date the engine would have. */
const at = (hhmm: string) => new Date(`2026-08-26T${hhmm}:00+07:00`);
const branch = (id: string, name: string, drop: string, t: string): UnmappedBranch =>
  ({ customer_id: id, pickup_name: name, dropoff_name: drop, at: at(t) });

section("the suggested window");
eq("mid-hour job takes its own hour", shiftWindowForJob(at("09:15")), { start: "09:00", end: "10:00" });
eq("a job ON the hour takes the hour BEFORE", shiftWindowForJob(at("10:00")), { start: "09:00", end: "10:00" });
eq("one minute past keeps the later hour", shiftWindowForJob(at("10:01")), { start: "10:00", end: "11:00" });
eq("first minute of the day wraps to the last hour", shiftWindowForJob(at("00:00")), { start: "23:00", end: "00:00" });
eq("late evening", shiftWindowForJob(at("23:30")), { start: "23:00", end: "00:00" });

section("the window must cover the job that caused it");
// The real check: hand the produced window to the ENGINE's own on-shift test.
// A window that excludes its own job would send the supervisor to fix a rule
// that could never have fired.
for (const t of ["00:00", "00:01", "06:30", "09:15", "10:00", "12:00", "17:59", "23:00", "23:59"]) {
  const { start, end } = shiftWindowForJob(at(t));
  const mapping = {
    customer_id: "C", driver_id: "d", smart_driver_id: [], first_name_last_name: "",
    shift_start: { hours: +start.split(":")[0], minutes: +start.split(":")[1] },
    shift_end: { hours: +end.split(":")[0], minutes: +end.split(":")[1] },
    bot_token: "", chat_id: "", alt_drop_off_id: "", dropoff_id: "",
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ok(`${t} falls inside ${start}–${end}`, isDriverOnShift(mapping as any, at(t)));
}

section("what the row says");
{
  const c = configCellsFor(branch("c1", "20079 - TUyen - BS Danh Vinh", "D001 - Lab", "09:15"));
  eq("the four facts, no column positions",
     c, { pickup: "20079 - TUyen - BS Danh Vinh", dropoff: "D001 - Lab", start: "09:00", end: "10:00" });
  ok("no driver is carried — that is the decision being asked for", !("driver" in c));
}
{
  const c = configCellsFor(branch("c1", "A branch", "", "09:15"));
  eq("a job with no destination says so", c.dropoff, "");
}
{
  const c = configCellsFor(branch("c1", "=SUM(A1:A9)", "+7", "09:15"));
  ok("a name that would be read as a formula is escaped", c.pickup.startsWith("'"));
  ok("...and so is the destination", c.dropoff.startsWith("'"));
}

section("one row per branch, not per job");
{
  const rows = dedupeBranches([
    branch("c1", "A", "X", "11:00"),
    branch("c1", "A", "Y", "08:30"),
    branch("c2", "B", "Z", "09:00"),
  ]);
  eq("two branches, two rows", rows.length, 2);
  const a = rows.find((r) => r.customer_id === "c1")!;
  eq("the EARLIEST job sets the window", shiftWindowForJob(a.at), { start: "08:00", end: "09:00" });
}
{
  eq("a branch with no name is not written", dedupeBranches([branch("c1", "", "X", "09:00")]), []);
  eq("nor one with no id", dedupeBranches([branch("", "A", "X", "09:00")]), []);
  eq("nothing found, nothing written", dedupeBranches([]), []);
}

section("what the writer is allowed to touch");
{
  const { CONFIG_TABS, WRITE_COLS, currentConfigTab } = await import("../src/lib/sheets-writer");
  const names: string[] = Object.values(WRITE_COLS);

  eq("four columns, by NAME — letters differ per tab and move when the sheet is reorganised",
     names.sort(), ["shift_end", "shift_start", "Điểm Drop-off", "Điểm Pick-up"].sort());

  // The safety property is what is ABSENT. None of these can be reached, because
  // no code path names them.
  for (const forbidden of [
    "customer_id", "dropoff_id", "alt_drop_off_id", "driver_id",  // spilling / per-row id formulas
    "Driver",                                                     // a FORMULA on the Sunday tab
    "Điểm Drop-off thay thế",                                     // an OVERRIDE — rewrites a destination
    "smart_driver_id", "bot_token", "chat_id",                    // derived
    "area_public_on_schedule", "f=fx", "drop_off_name",           // Sunday derivations
  ]) {
    ok(`never writes "${forbidden}"`, !names.includes(forbidden));
  }

  eq("two tabs, named as the workbook names them",
     [CONFIG_TABS.weekday.title, CONFIG_TABS.sunday.title], ["config", "(NO edit) CONFIG SUNDAY"]);
  ok("the tab chosen today is one of the two",
     [CONFIG_TABS.weekday.title, CONFIG_TABS.sunday.title].includes(currentConfigTab().title));
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
