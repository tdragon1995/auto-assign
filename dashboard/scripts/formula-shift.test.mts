/**
 * Formula row-shifting, pinned offline — the replacement for Sheets' copyPaste,
 * which is refused on a filtered range (see `formula-shift.ts`).
 *
 *   npx tsx scripts/formula-shift.test.mts
 */
import { shiftFormulaRows } from "../src/lib/formula-shift";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.error(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
}
function throws(label: string, fn: () => unknown) {
  try { fn(); failures++; console.error(`FAIL ${label}\n  no throw`); }
  catch { console.log(`ok   ${label}`); }
}

check("relative row shifts", shiftFormulaRows("=J5", 10), "=J15");
check("absolute row stays", shiftFormulaRows("=J$5+$J5", 10), "=J$5+$J15");
check("whole column untouched", shiftFormulaRows("=XLOOKUP(J5,Roster!A:A,Roster!B:B)", 3), "=XLOOKUP(J8,Roster!A:A,Roster!B:B)");
check("range both ends", shiftFormulaRows("=SUM(A5:C5)", -2), "=SUM(A3:C3)");
check("string literal untouched", shiftFormulaRows('=IF(J5="A1","B2",J5)', 1), '=IF(J6="A1","B2",J6)');
check("quoted sheet name untouched, ref shifts",
  shiftFormulaRows("='Lịch A1'!B5&'It''s C3'!D2", 1), "='Lịch A1'!B6&'It''s C3'!D3");
check("function names with digits untouched", shiftFormulaRows("=LOG10(A5)+ATAN2(B5,C5)", 1), "=LOG10(A6)+ATAN2(B6,C6)");
check("unquoted sheet name like a cell", shiftFormulaRows("=Q1!A5", 1), "=Q1!A6");
check("number literal untouched", shiftFormulaRows("=ROUND(J5,2)+1.5", 1), "=ROUND(J6,2)+1.5");
check("identifier with underscore untouched", shiftFormulaRows("=my_range1+A1", 1), "=my_range1+A2");
check("plain value passes through", shiftFormulaRows("abc A1", 5), "abc A1");
check("lowercase ref shifts", shiftFormulaRows("=j5", 1), "=j6");
throws("above row 1 refuses", () => shiftFormulaRows("=J2", -5));
throws("whole-row ref refuses", () => shiftFormulaRows("=SUM(5:5)", 1));

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall passed");
