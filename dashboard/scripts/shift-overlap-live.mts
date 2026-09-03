/**
 * How many overlapping shift pairs the LIVE config actually has, and whether
 * each one can be fixed by moving a single boundary.
 *
 * Run this before trusting the new "Trùng giờ" to-do section, and any time it
 * looks noisy. Two questions it answers that no offline test can:
 *
 *   1. HOW MANY. A handful is a to-do list; fifty would drown the coverage gaps
 *      sharing that panel, and the section would need collapsing instead.
 *   2. HOW MANY ARE FIXABLE IN ONE CLICK. A pair where one rule sits wholly
 *      inside the other cannot be — cutting either opens a hole — so it shows
 *      the "sửa cả ngày" line instead. If most rows say that, the one-click fix
 *      is not earning its place.
 *
 * Read-only: it fetches the sheet and prints. Nothing is written anywhere.
 *
 *   npx tsx scripts/shift-overlap-live.mts
 */

import { fetchSheetRows, SHEET_CONTRACT, SHEET_GID } from "../src/lib/sheets";
import { findShiftOverlaps, type AuditableRow } from "../src/lib/config-audit";
import { shrinkOptions } from "../src/lib/config-shift";
import type { BranchRule } from "../src/lib/types";

function parseTime(v: string | undefined): { hours: number; minutes: number } | null {
  const m = /^(\d{1,2}):(\d{2})/.exec((v ?? "").trim());
  return m ? { hours: Number(m[1]), minutes: Number(m[2]) } : null;
}
const hhmm = (t: { hours: number; minutes: number } | null) =>
  t ? `${String(t.hours).padStart(2, "0")}:${String(t.minutes).padStart(2, "0")}` : "";

const rows = await fetchSheetRows(SHEET_GID.mapping, {
  label: SHEET_CONTRACT.mapping.label,
  require: SHEET_CONTRACT.mapping.require,
});

const auditRows: AuditableRow[] = [];
const rulesByCustomer = new Map<string, BranchRule[]>();
const nameByCustomer = new Map<string, string>();

rows.forEach((r, idx) => {
  const customer_id = (r["customer_id"] ?? "").trim();
  if (!customer_id) return;
  const row = idx + 2; // header is row 1
  const driver = (r["Driver"] ?? "").trim();
  const start = parseTime(r["shift_start"]);
  const end = parseTime(r["shift_end"]);
  const pickup = (r["Điểm Pick-up"] ?? "").trim();
  if (pickup && !nameByCustomer.has(customer_id)) nameByCustomer.set(customer_id, pickup);

  auditRows.push({
    customer_id,
    driver_id: (r["driver_id"] ?? "").trim(),
    first_name_last_name: driver,
    shift_start: start,
    shift_end: end,
    dropoff_id: (r["dropoff_id"] ?? "").trim(),
    row,
  });
  const list = rulesByCustomer.get(customer_id) ?? [];
  list.push({ row, driver, start: hhmm(start), end: hhmm(end) });
  rulesByCustomer.set(customer_id, list);
});

const overlaps = findShiftOverlaps(auditRows, nameByCustomer);
console.log(`\n${rows.length} config row(s) read · ${overlaps.length} overlapping pair(s)\n`);

let oneClick = 0;
let editorOnly = 0;
for (const o of overlaps) {
  const rules = rulesByCustomer.get(o.customer_id) ?? [];
  const options = o.rules ? shrinkOptions(o.rules, rules) : [];
  if (options.length) oneClick++; else editorOnly++;
  const fix = options.length
    ? options.map((s) => `#${s.row} ${s.edge}→${s.value} (${s.window})`).join("  |  ")
    : "KHÔNG sửa được bằng 1 nút — một dòng nằm trọn trong dòng kia";
  console.log(`${o.pickup_name}  [${o.window}]`);
  console.log(`   ${o.drivers[0]}  vs  ${o.drivers[1]}`);
  if (o.rules) console.log(`   rows #${o.rules[0].row} ${o.rules[0].window}  ·  #${o.rules[1].row} ${o.rules[1].window}`);
  console.log(`   → ${fix}\n`);
}

console.log(
  `Summary: ${overlaps.length} pair(s) — ${oneClick} fixable by moving one boundary, ` +
  `${editorOnly} need the full-day editor.`,
);
// A branch can appear more than once; the panel lists one row per PAIR, which is
// what the supervisor acts on, so that is what the count above reflects.
const branches = new Set(overlaps.map((o) => o.customer_id));
console.log(`Across ${branches.size} branch(es).\n`);
