/**
 * What a leave write touches, and which row it takes — pinned offline.
 *
 * Two failures, both silent, both already in the live tab:
 *
 *   1. A DERIVED column written as a literal. `driver_id`, `day` and `sub#_id`
 *      are all looked up from a column beside them, and the row builder used to
 *      be a positional array with the driver's id sitting at index 1. Today that
 *      quietly replaces one row's formula — 76 rows have lost theirs. Under one
 *      ARRAYFORMULA per column it collapses the whole column to #REF!.
 *
 *   2. The row chosen by `values.append`, which reads a cell holding a formula
 *      as occupied even when the formula returns "". The tab carries 480 leave
 *      rows across 2,481, with two holes of exactly 1,000 rows where the per-row
 *      formulas were dragged down in advance and every append since has jumped
 *      over them.
 *
 *   npx tsx scripts/leave-write-ranges.test.mts
 */
import { leaveWriteRanges, pickFreeRow, appendShape, type LeaveCells } from "../src/lib/sheets-writer";

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
    else { failures++; console.error(`FAIL ${label}\n  got  ${m}`); }
  }
}

/** The live header, in order. A=0 … O=14. */
const HEADER = [
  "Ngày Nộp Đơn", "driver_id", "driver", "Loại Nghỉ", "leave_from", "leave_to",
  "leave_from_hr", "leave_to_hr", "day", "sub1_name", "sub1_id", "sub1_from",
  "sub1_to", "note", "Vị trí",
];
const LETTER = (i: number) => String.fromCharCode(65 + i);
const colOf = (header: string) => { const i = HEADER.indexOf(header); return i < 0 ? null : LETTER(i); };

const leave = (over: Partial<LeaveCells> = {}): LeaveCells => ({
  submitted_at: "2026-09-08 11:25:06",
  driver_name: "P - C - PTBU Lý Anh Tú",
  loai_nghi: "Nghỉ nguyên buổi",
  leave_from: "2026-10-01",
  leave_to: "2026-10-01",
  ...over,
});

const cols = (d: { range: string }[]) =>
  d.map((x) => x.range.split("!")[1].replace(/\d.*/, "")).sort();
const at = (d: { range: string; values: string[][] }[], c: string) =>
  d.find((x) => x.range.includes(`!${c}`))?.values;

// ── the derived columns are unreachable ──────────────────────────────────────
{
  const d = leaveWriteRanges("'Leave Status'", colOf, [leave({ note: "MISA auto" })], 401);
  check("writes only value columns", cols(d), ["A", "C", "D", "E", "F", "G", "H", "N"]);
  for (const [name, letter] of [["driver_id", "B"], ["day", "I"], ["sub1_id", "K"]] as const) {
    check(`never writes ${name}`, cols(d).includes(letter), false);
  }
  check("the name the ids are derived FROM is written", at(d, "C"), [["P - C - PTBU Lý Anh Tú"]]);
  check("one cell per column, at the chosen row", d[0].range, "'Leave Status'!A401:A401");
  check("the note lands in its own column", at(d, "N"), [["MISA auto"]]);
}

// ── a reused row is cleared, not half-overwritten ────────────────────────────
{
  // A resignation has no end date and no hours. Row 401 may have held a leave
  // that did — leaving those cells alone would staple the old values onto it.
  const d = leaveWriteRanges("'x'", colOf, [leave({ leave_to: null, leave_from_hr: null })], 401);
  check("an absent field blanks its cell", [at(d, "F"), at(d, "G")], [[[""]], [[""]]]);
}

// ── a column the tab does not have is skipped, never guessed ─────────────────
{
  const noNote = (h: string) => (h === "note" ? null : colOf(h));
  check("no note column, no note range", cols(leaveWriteRanges("'x'", noNote, [leave()], 5)).includes("N"), false);
}
throws(
  "a tab with no driver column is refused",
  () => leaveWriteRanges("'x'", (h) => (h === "driver" ? null : colOf(h)), [leave()], 5),
  "thiếu cột driver",
);
throws(
  "…and one with no leave_from",
  () => leaveWriteRanges("'x'", (h) => (h === "leave_from" ? null : colOf(h)), [leave()], 5),
  "thiếu cột leave_from",
);

// ── a range of days is one contiguous block ──────────────────────────────────
{
  const d = leaveWriteRanges("'x'", colOf, [
    leave({ leave_from: "2026-10-01", leave_to: "2026-10-01" }),
    leave({ leave_from: "2026-10-02", leave_to: "2026-10-02" }),
    leave({ leave_from: "2026-10-03", leave_to: "2026-10-03" }),
  ], 401);
  check("three days span three rows", d[0].range, "'x'!A401:A403");
  check("in order down the column", at(d, "E"), [["2026-10-01"], ["2026-10-02"], ["2026-10-03"]]);
}

// ── which row it takes ───────────────────────────────────────────────────────
{
  // The live shape: data in 2–400, then a thousand rows carrying nothing but
  // their formulas. Append jumped to 1401; this takes 401.
  const col = Array.from({ length: 2480 }, (_, i) => (i < 399 ? "someone" : ""));
  check("the first blank row after the data", pickFreeRow(col, 2, 1), 401);

  check("a run must be CONSECUTIVE for a multi-day leave",
        pickFreeRow(["a", "", "b", "", "", "", "c"], 2, 3), 5);
  check("…and one row needs only one", pickFreeRow(["a", "", "b", "", "", ""], 2, 1), 3);
  check("a full tab gives up, and the caller falls back to append",
        pickFreeRow(["a", "b", "c"], 2, 1), null);
  check("…so does a tab with no run long enough",
        pickFreeRow(["a", "", "b", "", "c"], 2, 2), null);
  check("a blank tab starts at the first data row", pickFreeRow(["", "", ""], 2, 2), 2);
  check("whitespace is blank", pickFreeRow(["a", "   ", "  "], 2, 2), 3);
}

// ── the append fallback keeps the derived column blank ───────────────────────
{
  const [row] = appendShape([leave({ note: "MISA auto" })]);
  check("driver_id is left for the sheet to derive", row[1], null);
  check("the driver name still goes at index 2", row[2], "P - C - PTBU Lý Anh Tú");
  check("the note still lands on column N", row[13], "MISA auto");
  check("no note, no padding", appendShape([leave()])[0].length, 8);
}

console.log(failures ? `\n${failures} FAILED` : "\nAll leave-write checks passed");
process.exit(failures ? 1 : 0);
