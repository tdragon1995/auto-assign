/**
 * Searching the config table from the dashboard.
 *
 * This is the only search over ~1,700 rows anyone uses to answer "who covers
 * this branch?", and it also feeds the copy-from-another-branch picker — so a
 * miss is not a cosmetic failure: it either sends someone to the workbook, or it
 * hides the branch whose pattern they were about to copy.
 *
 * Two behaviours worth holding:
 *
 *   1. ACCENT FOLDING. "quynh" has to find "Quỳnh". Without it the search reads
 *      as broken rather than picky — the same failure the driver picker had.
 *   2. EVERY TERM, ANY FIELD. "d014 hùng" finds the branch-and-driver pair
 *      without the typist knowing which column each word lives in. Requiring all
 *      terms in ONE field would make the useful queries the failing ones.
 *
 *   npx tsx scripts/config-search.test.mts
 */

import { searchConfigRows } from "../src/components/config-browser-panel";
import type { ConfigRowView } from "../src/app/api/config/rows/route";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (label: string, got: unknown, want: unknown) =>
  check(label, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const row = (o: Partial<ConfigRowView>): ConfigRowView => ({
  row: 2, customer_id: "", pickup: "", driver: "", start: "", end: "", dropoff: "", smart: false, ...o,
});

const ROWS: ConfigRowView[] = [
  row({ row: 10, customer_id: "D014", pickup: "BRA - D014 - Quận 1", driver: "F - C - DC100320 Lý Chánh Hùng", start: "05:00", end: "13:25" }),
  row({ row: 11, customer_id: "D014", pickup: "BRA - D014 - Quận 1", driver: "F - C - DC100777 Nguyễn Hồng Sơn", start: "13:25", end: "19:00" }),
  row({ row: 12, customer_id: "D002", pickup: "BRA - D002 - NTrai", driver: "P - P - PT101147 Nguyễn Hữu Quỳnh", start: "07:00", end: "16:00" }),
  row({ row: 13, customer_id: "D037", pickup: "PS315 Nguyễn Thị Định", driver: "", start: "", end: "" }),
  row({ row: 14, customer_id: "D021", pickup: "BRA - D021 - TBinh", driver: "A, B", start: "06:00", end: "18:00", smart: true }),
];

const found = (q: string) => searchConfigRows(ROWS, q).map((r) => r.row);

console.log("finding a row");
eq("an empty query is everything, not nothing", searchConfigRows(ROWS, "").length, ROWS.length);
eq("whitespace alone is also everything", searchConfigRows(ROWS, "   ").length, ROWS.length);
eq("by branch code", found("d014"), [10, 11]);
eq("by place name", found("ntrai"), [12]);
eq("by driver", found("chánh hùng"), [10]);

console.log("folding accents");
eq("a name typed without accents still matches", found("quynh"), [12]);
eq("…and with them", found("Quỳnh"), [12]);
eq("đ is a letter, not a d with a mark", found("dinh"), [13]);
eq("case is ignored", found("LÝ CHÁNH HÙNG"), [10]);

console.log("several terms");
eq("every term must match, but any field may carry it", found("d014 sơn"), [11]);
eq("…so a term matching nothing narrows to nothing", found("d014 quỳnh"), []);
eq("a time is searchable too", found("13:25"), [10, 11]);

console.log("what a match is not");
eq("a branch with no driver is still findable — that IS the to-do", found("PS315"), [13]);
check("a smart row is not hidden", found("d021").length === 1);
eq("nothing matches gibberish", found("zzzz"), []);

console.log(failures === 0 ? "\nAll config-search checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
