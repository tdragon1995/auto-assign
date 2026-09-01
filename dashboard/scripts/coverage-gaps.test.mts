/**
 * Pins that a recorded gap closes when the config covers it — and only then.
 *
 * The closing is the part that matters. An alarm only its author can retract
 * outlives its author: that is what left a wrong banner standing all morning on
 * 2026-08-31. So a gap disappears because the CONFIG says it is covered, decided
 * fresh at every parse, not because anyone remembered to withdraw it.
 *
 *   npx tsx scripts/coverage-gaps.test.mts
 */
import type { RuleRow } from "../src/lib/config-audit";
const { resolveGaps, isCovered } = await import("../src/lib/config-audit");

let failed = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) return console.log(`  ok   ${label}`);
  failed++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
}
const eq = (l: string, got: unknown, want: unknown) =>
  ok(l, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);

const t = (v: string) => ({ hours: +v.split(":")[0], minutes: +v.split(":")[1] });
const rule = (row: number, driver: string, s: string | null, e: string | null): RuleRow =>
  ({ row, driver, start: s ? t(s) : null, end: e ? t(e) : null });
const gap = (at: string) => ({ customer_id: "C1", pickup_name: "PK Test", at });

// Cover uses the engine's own half-open window: the start minute belongs to the
// rule that is ending, so 14:30 is covered by 07:00–14:30 and NOT by 14:30–19:00.
const day = [rule(10, "An", "07:00", "14:30"), rule(11, "Bình", "16:30", "19:00")];
ok("a minute inside a rule is covered", isCovered(day, 10 * 60));
ok("the closing minute belongs to the rule that ends", isCovered(day, 14 * 60 + 30));
ok("the opening minute does NOT belong to the rule that starts", !isCovered(day, 16 * 60 + 30));
ok("a minute in the hole is not covered", !isCovered(day, 15 * 60 + 10));

{
  const { open, closed } = resolveGaps([gap("15:10")], new Map([["C1", day]]));
  eq("a gap that is still open stays open", open.length, 1);
  eq("...and nothing is retracted", closed.length, 0);
  eq("the rule before the hole is named, with its row", [open[0].before?.row, open[0].before?.driver], [10, "An"]);
  eq("so is the one after", [open[0].after?.row, open[0].after?.driver], [11, "Bình"]);
}
{
  // Someone stretched the earlier rule to 16:30. The hole is gone, so the record
  // must go — without anyone telling it to.
  const fixed = [rule(10, "An", "07:00", "16:30"), rule(11, "Bình", "16:30", "19:00")];
  const { open, closed } = resolveGaps([gap("15:10")], new Map([["C1", fixed]]));
  eq("a covered gap is retracted", closed, [{ customer_id: "C1", at: "15:10" }]);
  eq("...and drops off the list", open.length, 0);
}
{
  const allDay = [rule(10, "An", null, null)];
  eq("an all-day rule covers everything", resolveGaps([gap("03:00")], new Map([["C1", allDay]])).open.length, 0);
}
{
  const night = [rule(10, "An", "22:00", "06:00")];
  eq("an overnight rule covers past midnight", resolveGaps([gap("02:00")], new Map([["C1", night]])).open.length, 0);
  eq("...but not the afternoon", resolveGaps([gap("14:00")], new Map([["C1", night]])).open.length, 1);
}
{
  // A branch whose rules have ALL gone is a different problem — dropping the
  // record would hide it, so it stays open with no neighbours to offer.
  const { open, closed } = resolveGaps([gap("09:00")], new Map());
  eq("a branch that lost all its rules stays reported", open.length, 1);
  eq("...and is not silently retracted", closed.length, 0);
  eq("with no boundary to move", [open[0].before, open[0].after], [null, null]);
}
{
  const { open } = resolveGaps([gap("06:00")], new Map([["C1", [rule(10, "An", "07:00", "14:30")]]]));
  eq("a hole before the first rule offers only the later boundary",
     [open[0].before, open[0].after?.row], [null, 10]);
}
{
  const { closed } = resolveGaps([gap("nonsense")], new Map([["C1", day]]));
  eq("an unparseable time is dropped rather than kept for ever", closed.length, 1);
}
{
  // A gap is recorded at the MINUTE the job wanted — all a failing job knows — so
  // a branch with a standing early booking records a fresh minute every day. They
  // are one hole and one fix, so they must read as one to-do.
  const rules = new Map([["C1", day]]);
  const { open } = resolveGaps([gap("15:10"), gap("15:40"), gap("14:55")], rules);
  eq("minutes in the same hole collapse to one row", open.length, 1);
  eq("...headlined by the earliest", open[0].at, "14:55");
  eq("...with the rest kept as evidence it recurs", open[0].also, ["15:10", "15:40"]);
}
{
  // Two holes in one day are two different fixes: the boundaries either side are
  // different rows, so they must NOT be merged.
  const threeShifts = [
    rule(10, "An", "07:00", "11:00"),
    rule(11, "Bình", "12:00", "16:00"),
    rule(12, "Cường", "17:00", "21:00"),
  ];
  const { open } = resolveGaps([gap("11:30"), gap("16:30")], new Map([["C1", threeShifts]]));
  eq("separate holes stay separate", open.length, 2);
  eq("...each naming its own pair of rows",
     open.map((o) => [o.before?.row, o.after?.row]), [[10, 11], [11, 12]]);
}
{
  // Same minute, different branches. Grouping is per branch or one busy morning
  // would swallow every other clinic's hole.
  const rules = new Map([["C1", day], ["C2", day]]);
  const { open } = resolveGaps(
    [gap("15:10"), { customer_id: "C2", pickup_name: "PK Hai", at: "15:10" }], rules);
  eq("two branches with the same hole stay two rows", open.length, 2);
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
