/**
 * What a config write actually touches — pinned offline.
 *
 * This is the one decision in `writeConfigRows` worth a test: which cells go
 * into which columns. Everything around it is network. The failures it guards
 * are the expensive silent kind this file's header records — a value landing in
 * a column nobody named, or a rule filed WIDER than the one that was asked for.
 *
 *   npx tsx scripts/config-write-ranges.test.mts
 */
import { configWriteRanges } from "../src/lib/sheets-writer";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.error(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
}
function throws(label: string, fn: () => unknown, needle: string) {
  try { fn(); failures++; console.error(`FAIL ${label}\n  no throw`); }
  catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m.includes(needle)) console.log(`ok   ${label}`);
    else { failures++; console.error(`FAIL ${label}\n  got  ${m}\n  want …${needle}…`); }
  }
}

const WEEKDAY = { pickup: "B", dropoff: "F", start: "H", end: "I", driver: "D" };
const cell = (over: Partial<{ pickup: string; dropoff: string; start: string; end: string; driver: string }> = {}) =>
  ({ pickup: "PK D014", dropoff: "", start: "07:00", end: "12:00", ...over });

const ranges = (d: { range: string }[]) => d.map((x) => x.range);
const at = (d: { range: string; values: string[][] }[], col: string) =>
  d.find((x) => x.range.includes(`!${col}`))?.values;

// ── one rule, driver and hours in the same batch ──────────────────────────────
{
  const d = configWriteRanges("config", WEEKDAY, [cell({ driver: "D001 - Nguyễn Văn Nam" })], 1773);
  check("one row addresses one cell per column", ranges(d).sort(), [
    "'config'!B1773:B1773", "'config'!D1773:D1773", "'config'!F1773:F1773",
    "'config'!H1773:H1773", "'config'!I1773:I1773",
  ]);
  // Blank, not skipped: a fresh row must not inherit whatever a deleted rule
  // left in the cell, or the new rule silently answers for one destination.
  check("an unscoped rule blanks the destination cell", at(d, "F"), [[""]]);
  check("driver rides the same write as its hours", at(d, "D"), [["D001 - Nguyễn Văn Nam"]]);
  check("hours land in their own columns", [at(d, "H"), at(d, "I")], [[["07:00"]], [["12:00"]]]);
}

// ── the columns NOT named are unreachable ────────────────────────────────────
{
  const d = configWriteRanges("config", WEEKDAY, [cell({ driver: "X" })], 1773);
  const touched = new Set(ranges(d).map((r) => r.split("!")[1].replace(/\d.*/, "")));
  check("no id / alt-destination / formula column is written", [...touched].sort(), ["B", "D", "F", "H", "I"]);
}

// ── a rule is never filed wider than it was asked for ────────────────────────
throws(
  "no destination column + a scoped rule refuses",
  () => configWriteRanges("(NO edit) CONFIG SUNDAY", { ...WEEKDAY, dropoff: null }, [cell({ dropoff: "D001" })], 500),
  "cannot be limited to one destination",
);
check(
  "…but an unscoped rule is fine without the column",
  ranges(configWriteRanges("x", { ...WEEKDAY, dropoff: null }, [cell()], 5)).length,
  3,   // pickup + the two hours; no destination column to blank
);
throws(
  "a named driver with no Driver column refuses",
  () => configWriteRanges("x", { ...WEEKDAY, driver: null }, [cell({ driver: "Nam" })], 5),
  "không có cột Driver",
);
check(
  "…and a row with no driver never reaches for the column",
  ranges(configWriteRanges("x", { ...WEEKDAY, driver: null }, [cell()], 5)).some((r) => r.includes("!D")),
  false,
);
check(
  "a blank driver string is not a driver",
  ranges(configWriteRanges("x", { ...WEEKDAY, driver: null }, [cell({ driver: "   " })], 5)).length,
  4,   // …and no Driver column reached for
);

// ── several rules in one batch stay contiguous and in order ──────────────────
{
  const d = configWriteRanges("config", WEEKDAY, [
    cell({ start: "06:00", end: "12:00", driver: "A" }),
    cell({ start: "12:00", end: "19:00", driver: "B" }),
  ], 1773);
  check("the block spans exactly the rows needed", ranges(d).sort(), [
    "'config'!B1773:B1774", "'config'!D1773:D1774", "'config'!F1773:F1774",
    "'config'!H1773:H1774", "'config'!I1773:I1774",
  ]);
  check("row order is preserved down each column", at(d, "D"), [["A"], ["B"]]);
}

// ── a quoted tab name cannot break out of its A1 reference ───────────────────
check(
  "an apostrophe in the tab name is doubled",
  ranges(configWriteRanges("Bob's config", WEEKDAY, [cell()], 9))[0],
  "'Bob''s config'!B9:B9",
);

console.log(failures ? `\n${failures} FAILED` : "\nAll config-write-range checks passed");
process.exit(failures ? 1 : 0);
