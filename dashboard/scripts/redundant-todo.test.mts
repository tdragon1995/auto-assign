/**
 * Pins that a to-do row disappears once the branch is actually covered.
 *
 * The row is written when a branch has NO rule at all. By the time anyone looks,
 * one may have been added — by hand or from the dashboard — and the empty row is
 * then litter that reads as outstanding work. Live case: row 1773 asked for a
 * driver for 08:00–09:00 at BV ĐA KHOA ISHII while row 407 had covered
 * 05:00–18:00 the whole time.
 *
 *   npx tsx scripts/redundant-todo.test.mts
 */
import type { RuleRow } from "../src/lib/config-audit";
const { coversWindow } = await import("../src/lib/config-audit");

let failed = 0;
function ok(label: string, cond: boolean) {
  if (cond) return console.log(`  ok   ${label}`);
  failed++;
  console.log(`  FAIL ${label}`);
}

const t = (v: string) => ({ hours: +v.split(":")[0], minutes: +v.split(":")[1] });
const rule = (s: string | null, e: string | null): RuleRow =>
  ({ row: 1, driver: "An", start: s ? t(s) : null, end: e ? t(e) : null });

const allDay = [rule("05:00", "18:00")];
ok("the live case: 08:00–09:00 inside 05:00–18:00 is covered", coversWindow(allDay, "08:00", "09:00"));
ok("a window ending exactly where cover ends is covered", coversWindow(allDay, "17:00", "18:00"));
ok("a window starting exactly where cover starts is covered", coversWindow(allDay, "05:00", "06:00"));
ok("a window running past the end is NOT covered", !coversWindow(allDay, "17:30", "18:30"));
ok("a window before cover begins is NOT covered", !coversWindow(allDay, "04:00", "05:00"));
ok("an unrelated window is NOT covered", !coversWindow(allDay, "20:00", "21:00"));

ok("no rules at all covers nothing", !coversWindow([], "08:00", "09:00"));
ok("a rule with no window covers everything", coversWindow([rule(null, null)], "08:00", "09:00"));

// Two rules that hand over cleanly cover the join; a gap between them does not.
const split = [rule("06:00", "12:00"), rule("12:00", "18:00")];
ok("cover spanning a clean handover counts", coversWindow(split, "11:00", "13:00"));
const holed = [rule("06:00", "12:00"), rule("14:00", "18:00")];
ok("a window straddling a hole is NOT covered", !coversWindow(holed, "11:00", "15:00"));

// Overnight, and the degenerate cases.
ok("an overnight rule covers past midnight", coversWindow([rule("22:00", "06:00")], "23:00", "00:00"));
ok("a zero-length window is never 'covered'", !coversWindow(allDay, "09:00", "09:00"));
ok("junk times are not covered", !coversWindow(allDay, "sáng", "chiều"));

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
