/**
 * Pins the arithmetic that closes a coverage gap by MOVING ONE BOUNDARY.
 *
 * `/api/config/stretch-rule` writes the cell and checks only that the row still
 * holds the branch it was told to expect — it does not check the result against
 * the rest of the branch. So the whole guard against writing a broken roster
 * lives on this side, and getting it wrong is not a rendering bug: two rules
 * alive at the same minute make the engine refuse that branch's jobs outright,
 * and a boundary moved too far silently hands a driver hours nobody agreed to.
 *
 * The half-open window is the thing to hold on to: a rule covers (start, end],
 * so the minute named by `start` belongs to the OUTGOING rule. Extending the
 * rule BEFORE a hole therefore writes the LAST uncovered minute into its end,
 * while extending the rule AFTER writes the minute BEFORE the first uncovered
 * one into its start. Off by one in either direction and the hole is still there.
 *
 *   npx tsx scripts/config-shift.test.mts
 */
import type { BranchRule, CoverageGap } from "../src/lib/types";
const { stretchOptions, shrinkOptions, overlapKey, findClash, blocks, toMin, fromMin } =
  await import("../src/lib/config-shift");

let failed = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) return console.log(`  ok   ${label}`);
  failed++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
}

const rule = (row: number, driver: string, start: string, end: string): BranchRule =>
  ({ row, driver, start, end }) as BranchRule;

const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, JSON.stringify(got) === JSON.stringify(want),
    `got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);

const gap = (at: string, g: Partial<CoverageGap> = {}): CoverageGap => ({
  customer_id: "D014", pickup_name: "PS315", at,
  before: null, after: null, ...g,
}) as CoverageGap;

/** Is minute m covered by any of these rules? Mirrors the engine via blocks(). */
const covered = (m: number, rules: BranchRule[]) =>
  rules.some((r) => blocks({ key: `row:${r.row}`, row: r.row, driver: r.driver, start: r.start, end: r.end })
    .some(([a, b]) => m >= a && m <= b));

console.log("\ntime helpers");
ok("toMin/fromMin round-trip", fromMin(toMin("16:45")) === "16:45");
ok("fromMin wraps below midnight", fromMin(-1) === "23:59", `got ${fromMin(-1)}`);
ok("fromMin wraps past midnight", fromMin(1440) === "00:00", `got ${fromMin(1440)}`);

console.log("\nextending the rule BEFORE the hole");
{
  // 07:00–16:00 then 16:30–22:00. Nobody covers 16:01..16:30; a job needed 16:15.
  const rules = [rule(10, "Nam", "07:00", "16:00"), rule(11, "Hùng", "16:30", "22:00")];
  const g = gap("16:15", {
    before: { row: 10, driver: "Nam", window: "07:00–16:00" },
    after: { row: 11, driver: "Hùng", window: "16:30–22:00" },
  });
  const out = stretchOptions(g, rules);
  const end = out.find((s) => s.edge === "end");
  const start = out.find((s) => s.edge === "start");

  ok("offers both neighbours", out.length === 2, JSON.stringify(out));
  ok("before's end moves to the uncovered minute", end?.value === "16:15", `got ${end?.value}`);
  ok("before's new window reads 07:00–16:15", end?.window === "07:00–16:15", `got ${end?.window}`);
  ok("after's start moves to one minute earlier", start?.value === "16:14", `got ${start?.value}`);
  ok("after's new window reads 16:14–22:00", start?.window === "16:14–22:00", `got ${start?.window}`);

  // The point of the whole exercise: the minute is actually covered afterwards.
  const applied = rules.map((r) => (r.row === 10 ? rule(10, "Nam", "07:00", end!.value) : r));
  ok("16:15 is covered after stretching before", covered(toMin("16:15"), applied));
  const applied2 = rules.map((r) => (r.row === 11 ? rule(11, "Hùng", start!.value, "22:00") : r));
  ok("16:15 is covered after stretching after", covered(toMin("16:15"), applied2));
  ok("stretching before does not clash", findClash(applied.map((r) =>
    ({ key: `row:${r.row}`, row: r.row, driver: r.driver, start: r.start, end: r.end }))) === null);
  ok("stretching after does not clash", findClash(applied2.map((r) =>
    ({ key: `row:${r.row}`, row: r.row, driver: r.driver, start: r.start, end: r.end }))) === null);
}

console.log("\na hole that has recurred — the whole run must be swallowed");
{
  const rules = [rule(10, "Nam", "07:00", "16:00"), rule(11, "Hùng", "16:45", "22:00")];
  const g = gap("16:05", {
    also: ["16:15", "16:30"],
    before: { row: 10, driver: "Nam", window: "07:00–16:00" },
    after: { row: 11, driver: "Hùng", window: "16:45–22:00" },
  });
  const out = stretchOptions(g, rules);
  const end = out.find((s) => s.edge === "end");
  const start = out.find((s) => s.edge === "start");
  ok("before's end reaches the LATEST minute", end?.value === "16:30", `got ${end?.value}`);
  ok("after's start reaches before the EARLIEST", start?.value === "16:04", `got ${start?.value}`);

  const applied = rules.map((r) => (r.row === 10 ? rule(10, "Nam", "07:00", end!.value) : r));
  for (const m of ["16:05", "16:15", "16:30"]) {
    ok(`${m} covered after stretching before`, covered(toMin(m), applied));
  }
  const applied2 = rules.map((r) => (r.row === 11 ? rule(11, "Hùng", start!.value, "22:00") : r));
  for (const m of ["16:05", "16:15", "16:30"]) {
    ok(`${m} covered after stretching after`, covered(toMin(m), applied2));
  }
}

console.log("\nrefusals — the cases that must NOT be offered");
{
  // A third rule sits inside the hole, so stretching either neighbour lands on it.
  const rules = [
    rule(10, "Nam", "07:00", "16:00"),
    rule(12, "Linh", "16:00", "16:20"),
    rule(11, "Hùng", "16:30", "22:00"),
  ];
  const g = gap("16:25", {
    before: { row: 10, driver: "Nam", window: "07:00–16:00" },
    after: { row: 11, driver: "Hùng", window: "16:30–22:00" },
  });
  const out = stretchOptions(g, rules);
  ok("does not offer a stretch that lands on a neighbour",
    out.every((s) => s.edge !== "end"), JSON.stringify(out));
}
{
  const g = gap("08:00", { before: null, after: null });
  ok("no neighbours, no options", stretchOptions(g, []).length === 0);
}
{
  // Minutes either side of midnight are not one hole for this purpose.
  const rules = [rule(10, "Nam", "07:00", "23:00")];
  const g = gap("23:30", {
    also: ["00:20"],
    before: { row: 10, driver: "Nam", window: "07:00–23:00" },
  });
  ok("a run that straddles midnight is left to the editor", stretchOptions(g, rules).length === 0);
}
{
  // Stretching would collapse the rule to start === end, i.e. never on duty.
  const rules = [rule(10, "Nam", "16:15", "22:00")];
  const g = gap("16:15", { after: { row: 10, driver: "Nam", window: "16:15–22:00" } });
  const out = stretchOptions(g, rules);
  ok("never proposes a window that is never on duty",
    out.every((s) => s.window.split("–")[0] !== s.window.split("–")[1]), JSON.stringify(out));
}
{
  const g = gap("bad-time", { before: { row: 10, driver: "Nam", window: "07:00–16:00" } });
  ok("an unparseable minute yields nothing", stretchOptions(g, []).length === 0);
}

// ── Closing an OVERLAP by moving one boundary ────────────────────────────────
//
// The mirror of the gap direction, and it writes to the same cell through the
// same route — so the same thing is at stake: a boundary moved onto a neighbour
// makes the engine refuse the branch's jobs outright.
//
// The trap worth pinning is CONTAINMENT. One rule wholly inside another looks
// closable — cut the outer one down to where the inner starts — and doing that
// trades a CLASH for a five-hour HOLE, which is the worse fault: the engine
// refuses those jobs too, and nothing in the sheet says why. Nothing may be
// offered there.
{
  console.log("closing an overlap");
  const side = (row: number, driver: string, window: string) => ({ row, driver, window });

  // Two rules that simply run into each other: A until 16:00, B from 15:00.
  {
    const rules: BranchRule[] = [
      { row: 10, driver: "A", start: "07:00", end: "16:00" },
      { row: 11, driver: "B", start: "15:00", end: "20:00" },
    ];
    const out = shrinkOptions([side(10, "A", "07:00–16:00"), side(11, "B", "15:00–20:00")], rules);
    eq("both single-boundary fixes are offered",
      out.map((s) => [s.row, s.edge, s.value]),
      [[10, "end", "15:00"], [11, "start", "16:00"]]);
    eq("…and each states the window it ends up with",
      out.map((s) => s.window), ["07:00–15:00", "16:00–20:00"]);
  }

  // A wholly contains B. Cutting A opens 12:00–20:00; moving B's start past its
  // own end inverts it. Neither may be offered.
  {
    const rules: BranchRule[] = [
      { row: 10, driver: "A", start: "05:00", end: "20:00" },
      { row: 11, driver: "B", start: "08:00", end: "12:00" },
    ];
    const out = shrinkOptions([side(10, "A", "05:00–20:00"), side(11, "B", "08:00–12:00")], rules);
    eq("a contained rule offers nothing — a hole is worse than the clash", out.length, 0);
  }

  // Identical windows: shrinking either leaves it covering nothing at all.
  {
    const rules: BranchRule[] = [
      { row: 10, driver: "A", start: "07:00", end: "16:00" },
      { row: 11, driver: "B", start: "07:00", end: "16:00" },
    ];
    const out = shrinkOptions([side(10, "A", "07:00–16:00"), side(11, "B", "07:00–16:00")], rules);
    eq("two identical rules cannot be separated by one boundary", out.length, 0);
  }

  // A third rule sits where one of the moves would land, so only the other survives.
  {
    const rules: BranchRule[] = [
      { row: 10, driver: "A", start: "07:00", end: "16:00" },
      { row: 11, driver: "B", start: "15:00", end: "20:00" },
      { row: 12, driver: "C", start: "20:00", end: "22:00" },
    ];
    const out = shrinkOptions([side(10, "A", "07:00–16:00"), side(11, "B", "15:00–20:00")], rules);
    eq("the untouched neighbour does not block the valid moves",
      out.map((s) => s.row), [10, 11]);
  }

  // A rule with no window is on duty all day; no single boundary separates it.
  {
    const rules: BranchRule[] = [
      { row: 10, driver: "A", start: "", end: "" },
      { row: 11, driver: "B", start: "08:00", end: "12:00" },
    ];
    eq("an all-day rule goes to the editor",
      shrinkOptions([side(10, "A", ""), side(11, "B", "08:00–12:00")], rules).length, 0);
  }

  // The key has to survive the fix changing the window, or the row reappears as
  // new the moment it is dealt with.
  eq("the dismiss key is the branch and the two rows",
    overlapKey({ customer_id: "D014", rules: [{ row: 11 }, { row: 10 }] }), "D014|10-11");
  eq("…in a stable order whichever side is listed first",
    overlapKey({ customer_id: "D014", rules: [{ row: 10 }, { row: 11 }] }),
    overlapKey({ customer_id: "D014", rules: [{ row: 11 }, { row: 10 }] }));
}

console.log(failed === 0 ? "\nAll config-shift assertions passed.\n" : `\n${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
