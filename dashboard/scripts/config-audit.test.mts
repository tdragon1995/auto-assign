/**
 * Pins the config audit: duplicate branch names, overlapping shift rules, and
 * lookups that stopped resolving.
 *
 * Offline and pure — no sheet, no network. The live counterpart is
 * `config-audit-live.mts`, which runs the same checks against the real workbook.
 *
 *   npx tsx scripts/config-audit.test.mts
 */

import type { AuditableRow, LocationRow } from "../src/lib/config-audit";
const {
  findDuplicateBranches, findShiftOverlaps,
  duplicateBranchWarning, shiftOverlapWarning, unresolvedWarning,
} = await import("../src/lib/config-audit");

let failed = 0;
const section = (s: string) => console.log(`\n${s}`);
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) return console.log(`  ok   ${label}`);
  failed++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
}
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);

const loc = (customer_name: string, customer_id: string): LocationRow => ({ customer_name, customer_id });

// The audit only counts a row whose driver cell holds a REAL id, so fixtures have
// to carry one. Short keys are mapped to stable uuid-shaped ids for readability.
const IDS: Record<string, string> = {};
let idN = 0;
const uid = (k: string) => k ? (IDS[k] ??= `00000000-0000-0000-0000-${String(++idN).padStart(12, "0")}`) : "";

const row = (
  customer_id: string, driver_id: string, name: string,
  start: string | null, end: string | null, dropoff_id = "",
): AuditableRow => {
  const t = (v: string | null) => v ? { hours: +v.split(":")[0], minutes: +v.split(":")[1] } : null;
  return { customer_id, driver_id: uid(driver_id), first_name_last_name: name, shift_start: t(start), shift_end: t(end), dropoff_id };
};

// ── duplicate branch names ───────────────────────────────────────────────────
section("a branch name that means two places");
{
  const rows = [loc("A", "id1"), loc("B", "id2"), loc("A", "id9")];
  const d = findDuplicateBranches(rows, new Set(["A"]));
  eq("the duplicate is found", d.map((x) => x.name), ["A"]);
  eq("both ids reported, sheet order kept", d[0].ids, ["id1", "id9"]);
  ok("and it is flagged as collected-from", d[0].usedAsPickup);
}
{
  const d = findDuplicateBranches([loc("A", "id1"), loc("A", "id1")], new Set(["A"]));
  eq("the same place listed twice under ONE id is not a fault", d, []);
}
{
  const d = findDuplicateBranches([loc("A", "id1"), loc("A", "id2")], new Set());
  ok("a duplicate nobody collects from is still found", d.length === 1);
  ok("...but not flagged as collected-from", d[0].usedAsPickup === false);
  eq("and it raises no banner on its own", duplicateBranchWarning(d), null);
}
{
  const rows = [loc("Z", "1"), loc("Z", "2"), loc("A", "3"), loc("A", "4")];
  const d = findDuplicateBranches(rows, new Set(["A"]));
  eq("collected-from ones sort first", d.map((x) => x.name), ["A", "Z"]);
}
{
  const rows = [loc("", "id1"), loc("", "id2"), loc("X", ""), loc("X", "")];
  eq("blank names and blank ids are ignored", findDuplicateBranches(rows, new Set()), []);
}
{
  const d = findDuplicateBranches([loc("A", "1"), loc("A", "2")], new Set(["A"]));
  const msg = duplicateBranchWarning(d) ?? "";
  ok("the banner names the place", msg.includes("A"));
  ok("...and says what it will look like when it bites", msg.includes("chưa cấu hình"));
}
eq("nothing duplicated, nothing said", duplicateBranchWarning([]), null);

// ── overlapping shift rules ──────────────────────────────────────────────────
section("two rules for one branch, live at the same minute");
{
  const o = findShiftOverlaps([row("C1", "d1", "An", "06:00", "12:00"), row("C1", "d2", "Bình", "10:00", "18:00")]);
  ok("a plain overlap is found", o.length === 1);
  eq("both drivers are named", o[0].drivers, ["An", "Bình"]);
  eq("and the contested window is reported", o[0].window, "10:00–12:00");
}
{
  const o = findShiftOverlaps([row("C1", "d1", "An", "06:00", "12:00"), row("C1", "d2", "Bình", "12:00", "18:00")]);
  eq("shifts that hand over at the boundary do NOT overlap", o, []);
}
{
  const o = findShiftOverlaps([row("C1", "d1", "An", "06:00", "12:00"), row("C2", "d2", "Bình", "06:00", "12:00")]);
  eq("different branches never clash with each other", o, []);
}
{
  const o = findShiftOverlaps([row("C1", "d1", "An", "06:00", "12:00"), row("C1", "d1", "An", "06:00", "18:00")]);
  eq("the same driver twice is redundant, not ambiguous", o, []);
}
{
  const o = findShiftOverlaps([row("C1", "d1", "An", null, null), row("C1", "d2", "Bình", "06:00", "12:00")]);
  ok("a blank window means all day, so it overlaps everything", o.length === 1);
  eq("...and the overlap is the narrower window", o[0].window, "06:00–12:00");
}
{
  const o = findShiftOverlaps([row("C1", "d1", "An", "22:00", "06:00"), row("C1", "d2", "Bình", "05:00", "09:00")]);
  ok("an overnight shift is matched past midnight", o.length === 1);
  eq("...reporting where the two actually meet", o[0].window, "05:00–06:00");
}
{
  const o = findShiftOverlaps([row("C1", "d1", "An", "08:00", "08:00"), row("C1", "d2", "Bình", "06:00", "18:00")]);
  eq("a row whose start equals its end is never on duty", o, []);
}
{
  const o = findShiftOverlaps([row("C1", "", "An", "06:00", "12:00"), row("C1", "", "Bình", "06:00", "12:00")]);
  eq("smart-assign rows (no fixed driver) are not counted", o, []);
}
{
  const o = findShiftOverlaps([row("C1", "d1", "", "06:00", "12:00"), row("C1", "d2", "", "06:00", "12:00")]);
  eq("a nameless row falls back to its id", o[0].drivers, [uid("d1"), uid("d2")]);
}
{
  const msg = shiftOverlapWarning(findShiftOverlaps([
    row("C1", "d1", "An", "06:00", "12:00"), row("C1", "d2", "Bình", "10:00", "18:00"),
  ])) ?? "";
  ok("the banner says what will happen", msg.includes("CLASH"));
}
{
  const o = findShiftOverlaps([
    row("C1", "d1", "An", "06:00", "18:00", "D001"),
    row("C1", "d2", "Bình", "06:00", "18:00", "D007"),
  ]);
  eq("rows for DIFFERENT destinations never compete", o, []);
}
{
  const o = findShiftOverlaps([
    row("C1", "d1", "An", "06:00", "18:00", "D001"),
    row("C1", "d2", "Bình", "06:00", "18:00", "D001"),
  ]);
  ok("...but the same destination still clashes", o.length === 1);
}
{
  const o = findShiftOverlaps([
    row("C1", "d1", "An", "06:00", "18:00", ""),
    row("C1", "d2", "Bình", "06:00", "18:00", "D001"),
  ]);
  eq("a specific destination beats an any-destination row, so neither competes", o, []);
}
{
  const o = findShiftOverlaps([
    { customer_id: "C1", driver_id: uid("d1"), first_name_last_name: "An", shift_start: { hours: 6, minutes: 0 }, shift_end: { hours: 18, minutes: 0 } },
    { customer_id: "C1", driver_id: uid("d2"), first_name_last_name: "Bình", shift_start: { hours: 6, minutes: 0 }, shift_end: { hours: 18, minutes: 0 } },
  ]);
  ok("rows with no destination field at all behave as today", o.length === 1);
}

eq("no overlap, nothing said", shiftOverlapWarning([]), null);

// ── lookups that stopped resolving ───────────────────────────────────────────
section("names the workbook could not turn into an id");
eq("nothing dropped, nothing said", unresolvedWarning({ pickups: [], drivers: [], dropoffs: [], invalidDriverIds: [] }), null);
{
  const msg = unresolvedWarning({ pickups: ["Điểm X"], drivers: [], dropoffs: [], invalidDriverIds: [] }) ?? "";
  ok("a branch that did not resolve is named", msg.includes("Điểm X"));
  ok("...and called a branch problem", msg.includes("mã khách"));
}
{
  const msg = unresolvedWarning({ pickups: [], drivers: ["Điểm Y: Nguyễn Văn A"], dropoffs: [], invalidDriverIds: [] }) ?? "";
  ok("a driver that did not resolve is named", msg.includes("Nguyễn Văn A"));
  ok("...and blamed on the rename, not the customer", msg.includes("đổi tên"));
}
{
  const msg = unresolvedWarning({ pickups: ["a", "b", "c", "d", "e"], drivers: [], dropoffs: [], invalidDriverIds: [] }) ?? "";
  ok("a long list is truncated", msg.includes("và 2 dòng nữa"));
}
{
  const msg = unresolvedWarning({ pickups: ["a"], drivers: ["b: c"], dropoffs: [], invalidDriverIds: [] }) ?? "";
  ok("both kinds are reported together", msg.includes("mã khách") && msg.includes("driver_id"));
}

{
  const msg = unresolvedWarning({ pickups: [], drivers: [], dropoffs: ["Điểm Y: Kho Z"], invalidDriverIds: [] }) ?? "";
  ok("a destination that did not resolve is named", msg.includes("Kho Z"));
  ok("...and says the row WIDENS rather than vanishes", msg.includes("mất giới hạn điểm giao"));
  ok("...so it must not claim the row was skipped", !msg.includes("bị bỏ qua"));
}
{
  const msg = unresolvedWarning({ pickups: ["a"], drivers: [], dropoffs: ["b: c"], invalidDriverIds: [] }) ?? "";
  ok("dropped and widened rows are reported together", msg.includes("bị bỏ qua") && msg.includes("mất giới hạn"));
}

{
  const o = findShiftOverlaps([
    row("C1", "d1", "An", "06:00", "18:00"),
    { customer_id: "C1", driver_id: "KHÔNG TÌM THẤY", first_name_last_name: "Bình",
      shift_start: { hours: 6, minutes: 0 }, shift_end: { hours: 18, minutes: 0 } },
  ]);
  eq("a failed-lookup cell is a broken row, not a competing driver", o, []);
}
{
  const msg = unresolvedWarning({ pickups: [], drivers: [], dropoffs: [], invalidDriverIds: ["Điểm X: KHÔNG TÌM THẤY"] }) ?? "";
  ok("...and is named on its own", msg.includes("KHÔNG phải là id"));
  ok("...without claiming the row was skipped", !msg.includes("bị bỏ qua"));
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
