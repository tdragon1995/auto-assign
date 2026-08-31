/**
 * Pins that a data warning is never dressed up as a refused tab.
 *
 * Both used to render with the same words — "engine đang chạy bằng bản cũ" and
 * "mọi thay đổi trên tab đó không có tác dụng". For overlapping rows that is
 * simply false: the tab reads fine and edits take effect. Whoever read it would
 * go looking for a broken column that was never broken.
 *
 *   npx tsx scripts/sheet-alarm-split.test.mts
 */
import type { SheetAlarm } from "../src/lib/types";
const { noteSheetLoad, noteSheetWarning, drainSheetAlarms, currentSheetRefusals } =
  await import("../src/lib/sheets");
const { SheetShapeError } = await import("../src/lib/sheets");

let failed = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) return console.log(`  ok   ${label}`);
  failed++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
}
const eq = (l: string, got: unknown, want: unknown) =>
  ok(l, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);

// A tab that could not be read.
noteSheetLoad("config (mapping)", new SheetShapeError("config (mapping)", "thiếu cột driver_id"));
// A tab that read fine but carries bad rows.
noteSheetWarning("config — trùng giờ", "4 cặp dòng TRÙNG GIỜ cho cùng một điểm");

const all = drainSheetAlarms() ?? [];
const byKind = (k: string) => all.filter((a: SheetAlarm) => (a.kind ?? "refused") === k);

eq("both reach the dashboard", all.length, 2);
eq("the unreadable tab is tagged refused", byKind("refused").map((a) => a.label), ["config (mapping)"]);
eq("the bad rows are tagged data", byKind("data").map((a) => a.label), ["config — trùng giờ"]);

ok("a data warning never claims a tab is unreadable",
   byKind("data").every((a) => !/sai cấu trúc|bản cũ/i.test(a.reason)));

// The live contract check must still see ONLY the refusal, or a branch with
// overlapping hours would fail a check about whether the sheet is readable.
eq("the readability check sees only the refusal",
   currentSheetRefusals().map((a) => a.label), ["config (mapping)"]);

// Clearing one must not clear the other.
noteSheetLoad("config (mapping)", null);
const after = drainSheetAlarms() ?? [];
eq("a fixed column clears the refusal", after.filter((a) => (a.kind ?? "refused") === "refused").length, 0);
eq("...and leaves the row warning standing", after.filter((a) => a.kind === "data").length, 1);

noteSheetWarning("config — trùng giờ", null);
eq("fixing the rows clears that too", (drainSheetAlarms() ?? []).length, 0);

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
