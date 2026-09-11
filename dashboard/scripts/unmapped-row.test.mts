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
const { shiftWindowForJob, configCellsFor, dedupeBranches, looksAutoCreated, scopedDropoffName } = await import("../src/lib/unmapped-row");
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
     c, { pickup: "20079 - TUyen - BS Danh Vinh", dropoff: "", start: "", end: "" });
  ok("no driver is carried — that is the decision being asked for", !("driver" in c));
}
{
  const c = configCellsFor(branch("c1", "A branch", "", "09:15"));
  eq("a job with no destination says so", c.dropoff, "");
}
eq("ordinary pending config is never scoped to a destination", scopedDropoffName("c1", "Some lab"), "");
{
  const c = configCellsFor(branch("3927b076-3af9-11ed-b939-506b8dbc8dfb", "=SUM(A1:A9)", "+7", "09:15"));
  ok("a name that would be read as a formula is escaped", c.pickup.startsWith("'"));
  ok("...and so is the destination", c.dropoff.startsWith("'"));
}

section("one row per branch AND destination, not per job");
{
  // Five stuck trips down the same route is one row.
  const same = dedupeBranches([
    branch("c1", "A", "X", "11:00"),
    branch("c1", "A", "X", "08:30"),
    branch("c1", "A", "X", "14:00"),
  ]);
  eq("the same route collapses to one row", same.length, 1);
  eq("the EARLIEST job sets the window", shiftWindowForJob(same[0].at), { start: "08:00", end: "09:00" });

  // ...but two DESTINATIONS are two rows. The row written carries the
  // destination, so one row can only ever answer for one of them; keying on the
  // branch alone wrote a row for wherever the first stuck job happened to be
  // going and left the other route failing with nothing on the list to fix it.
  const two = dedupeBranches([
    branch("c1", "A", "X", "11:00"),
    branch("c1", "A", "Y", "08:30"),
    branch("c2", "B", "Z", "09:00"),
  ]);
  eq("non-D001 pickup uses one row across destinations", two.length, 2);
  eq("each row keeps its own destination",
     two.filter((r) => r.customer_id === "c1").map((r) => r.dropoff_name).sort(), ["Y"]);
}
{
  eq("a branch with no name is not written", dedupeBranches([branch("c1", "", "X", "09:00")]), []);
  eq("nor one with no id", dedupeBranches([branch("", "A", "X", "09:00")]), []);
  eq("nothing found, nothing written", dedupeBranches([]), []);
}

section("internal legs between our own locations are not to-dos");
{
  const { DIAG_LOCATIONS } = await import("../src/lib/diag-locations");
  const d001 = DIAG_LOCATIONS.find((l) => l.name === "D001")!;
  const d032 = DIAG_LOCATIONS.find((l) => l.name === "D032")!;

  eq("D001 → D007 is dropped", dedupeBranches([
    { customer_id: d001.customer_id, pickup_name: d001.customer_name, dropoff_name: "BRA - D007", at: at("05:30") },
  ]), []);

  // Matched on the id even when the label has drifted — a rename must not
  // resurrect an internal leg as a to-do.
  eq("...by id, even under a different label", dedupeBranches([
    { customer_id: d032.customer_id, pickup_name: "something else entirely", dropoff_name: "BRA - D007", at: at("06:30") },
  ]), []);

  // ...and on the label when the id is one we do not recognise.
  eq("...and by label when the id is unfamiliar", dedupeBranches([
    { customer_id: "not-a-known-id", pickup_name: d001.customer_name, dropoff_name: "BRA - D007", at: at("06:30") },
  ]), []);

  const real = dedupeBranches([
    branch("c-real", "20079 - TUyen - BS Danh Vinh", "BRA - D001", "09:15"),
    { customer_id: d001.customer_id, pickup_name: d001.customer_name, dropoff_name: "BRA - D007", at: at("05:30") },
  ]);
  eq("a real clinic alongside an internal leg keeps only the clinic",
     real.map((r) => r.pickup_name), ["20079 - TUyen - BS Danh Vinh"]);

  // A SENDOUT is not an internal leg. D001 shipping to an outside lab is a real
  // configured route — it has rules with real drivers today — and excluding it on
  // the pickup alone is why a job to a third such lab reported "chưa cấu hình
  // điểm giao" every cycle with nothing on the to-do list to answer it.
  eq("D001 → an outside lab is kept", dedupeBranches([
    { customer_id: d001.customer_id, pickup_name: d001.customer_name,
      dropoff_name: "SENDOUT5 - D2 - 7A - K LABTECH", at: at("11:51") },
  ]).map((r) => r.dropoff_name), ["SENDOUT5 - D2 - 7A - K LABTECH"]);

  // With nowhere named, an internal leg is the safer reading — and the one this
  // has always taken.
  eq("...but a Diag pickup with no destination stays excluded", dedupeBranches([
    { customer_id: d001.customer_id, pickup_name: d001.customer_name, dropoff_name: "", at: at("05:30") },
  ]), []);

  // 3PL pickups were deliberately NOT excluded — they stay to-dos until told
  // otherwise, so this pins the decision rather than the omission.
  const tpl = dedupeBranches([branch("c-3pl", "3PL - TLT", "BRA - D001", "14:00")]);
  eq("a 3PL pickup is still listed", tpl.map((r) => r.pickup_name), ["3PL - TLT"]);
}

section("telling our own rows from ones that were always driverless");
{
  // By construction: every window this module writes comes from shiftWindowForJob,
  // so the check must accept everything it can produce, at every hour of the day.
  for (const t of ["00:00", "00:30", "06:59", "09:15", "10:00", "12:00", "23:00", "23:59"]) {
    const { start, end } = shiftWindowForJob(at(t));
    ok(`a window written for a ${t} job is recognised (${start}–${end})`,
       looksAutoCreated(`${start}–${end}`));
  }

  // The row that prompted this: a years-old test line, driverless forever.
  ok("a real working day is not one of ours", !looksAutoCreated("07:00–16:00"));
  ok("nor an afternoon shift", !looksAutoCreated("16:30–19:00"));
  ok("nor a half-hour", !looksAutoCreated("07:00–07:30"));
  ok("nor an off-the-hour hour", !looksAutoCreated("07:15–08:15"));
  ok("a row with no window at all is not ours", !looksAutoCreated(null));
  ok("...nor is an empty one", !looksAutoCreated(""));
  ok("...nor junk", !looksAutoCreated("sáng"));
  ok("the midnight wrap is still exactly one hour", looksAutoCreated("23:00–00:00"));
  ok("but a whole day is not", !looksAutoCreated("00:00–00:00"));
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
