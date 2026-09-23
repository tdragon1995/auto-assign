/**
 * Pins the bulk config writers against an in-memory sheet.
 *
 * They replaced a loop of per-row routes that ran out of Google's per-minute read
 * quota partway through a selection (~25 rows for an edit, ~15 for a delete), so
 * the two things worth pinning are: the CALL COUNT stays flat however many rows
 * are ticked, and the one batch still lands on the right rows — above all the
 * delete, where removing a row shifts every row below it.
 *
 *   npx tsx scripts/config-bulk-write.test.mts
 */
import { google } from "googleapis";

let failed = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) return console.log(`  ok   ${label}`);
  failed++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
}

// ── a fake workbook: one tab, header in row 1 ─────────────────────────────────
const HEADER = ["customer_id", "Điểm Pick-up", "x", "Driver", "shift_start", "shift_end"];
let grid: string[][] = [];
let calls = { get: 0, batchGet: 0, write: 0 };
const A = "Nguyễn Văn A", B = "Trần Thị B", C = "Lê C";

function reset() {
  grid = [HEADER];
  for (let r = 2; r <= 60; r++) grid.push([`id${r}`, `PK${r}`, "", r % 3 === 0 ? `${A}, ${C}` : r % 2 ? A : C, "07:00", "12:00"]);
  calls = { get: 0, batchGet: 0, write: 0 };
}
const colIdx = (l: string) => l.charCodeAt(0) - 65;
/** "'config'!D5" or "'config'!B1:B40" → cells; "1:1" → the header. */
function readRange(range: string): string[][] {
  const ref = range.split("!")[1];
  if (ref === "1:1") return [grid[0]];
  const m = /^([A-Z])(\d+)(?::([A-Z])(\d+))?$/.exec(ref)!;
  const c = colIdx(m[1]), r0 = +m[2], r1 = m[4] ? +m[4] : r0;
  const out: string[][] = [];
  for (let r = r0; r <= r1; r++) out.push([grid[r - 1]?.[c] ?? ""]);
  return out;
}
function writeRange(range: string, v: string) {
  const m = /!([A-Z])(\d+)$/.exec(range)!;
  grid[+m[2] - 1][colIdx(m[1])] = v;
}

const fake = {
  spreadsheets: {
    values: {
      get: async ({ range }: { range: string }) => { calls.get++; return { data: { values: readRange(range) } }; },
      batchGet: async ({ ranges }: { ranges: string[] }) => {
        calls.batchGet++;
        return { data: { valueRanges: ranges.map((r) => ({ values: readRange(r) })) } };
      },
      batchUpdate: async ({ requestBody }: { requestBody: { data: { range: string; values: string[][] }[] } }) => {
        calls.write++;
        for (const d of requestBody.data) writeRange(d.range, d.values[0][0]);
        return { data: {} };
      },
    },
    // Requests apply IN ORDER, as Google applies them — so a wrong order
    // deletes the wrong rows here exactly as it would on the real sheet.
    batchUpdate: async ({ requestBody }: { requestBody: { requests: { deleteDimension: { range: { startIndex: number; endIndex: number } } }[] } }) => {
      calls.write++;
      for (const q of requestBody.requests) {
        const { startIndex, endIndex } = q.deleteDimension.range;
        grid.splice(startIndex, endIndex - startIndex);
      }
      return { data: {} };
    },
  },
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(google as any).sheets = () => fake;
process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: "service_account", client_email: "t@t", private_key: "x" });

const { bulkUpdateConfigRows, bulkDeleteConfigRows, replaceConfigDriver } = await import("../src/lib/sheets-writer");
const { vnIsSunday } = await import("../src/lib/time");
if (vnIsSunday()) {
  console.log("Sunday: the writers refuse the Sunday tab by design — run this on a weekday.");
  process.exit(0);
}
const t = (row: number) => ({ row, expectPickup: `PK${row}` });
const pickups = () => grid.slice(1).map((r) => r[1]);

// ── bulk update: 40 rows, flat call count ─────────────────────────────────────
reset();
{
  const rows = Array.from({ length: 40 }, (_, i) => t(i + 3));
  const res = await bulkUpdateConfigRows({ targets: rows, driverName: B });
  ok("40 driver edits: 1 header read + 1 column read + 1 write",
    calls.get === 1 && calls.batchGet === 1 && calls.write === 1, JSON.stringify(calls));
  ok("every target now names B", rows.every((r) => grid[r.row - 1][3] === B));
  ok("hours untouched by a driver edit", grid[5][4] === "07:00" && grid[5][5] === "12:00");
  ok("rows outside the selection untouched", grid[1][3] === C && grid[44][3] !== B);
  ok("40 reported done", res.done.length === 40 && res.skipped.length === 0);
}
reset();
{
  await bulkUpdateConfigRows({ targets: [t(4), t(5)], start: "13:00", end: "17:30" });
  ok("window edit writes both ends", grid[3][4] === "13:00" && grid[3][5] === "17:30" && grid[4][5] === "17:30");
  ok("driver untouched by a window edit", grid[3][3] === C);
}
reset();
{
  const res = await bulkUpdateConfigRows({ targets: [t(4), { row: 5, expectPickup: "PK999" }], driverName: B });
  ok("a row whose branch moved is skipped, not written", grid[4][3] !== B && res.skipped[0]?.row === 5);
  ok("…and the others still land", grid[3][3] === B && res.done.length === 1);
}

// ── bulk delete: descending, atomic, right rows ───────────────────────────────
reset();
{
  const doomed = [5, 30, 6, 12, 59, 7];                 // ticked in no particular order
  const res = await bulkDeleteConfigRows({ targets: doomed.map(t) });
  const left = pickups();
  ok("exactly the ticked rows are gone", doomed.every((r) => !left.includes(`PK${r}`)) && left.length === 59 - doomed.length,
    `left ${left.length}`);
  ok("neighbours of every deleted row survive", ["PK4", "PK8", "PK11", "PK13", "PK29", "PK31", "PK58", "PK60"].every((p) => left.includes(p)));
  ok("one delete batch, one column read, header + read-back gets", calls.write === 1 && calls.batchGet === 1 && calls.get === 2,
    JSON.stringify(calls));
  ok("reported highest first", res.done.map((d) => d.row).join() === "59,30,12,7,6,5");
}
reset();
{
  const res = await bulkDeleteConfigRows({ targets: [t(2), t(9)] });
  ok("row 2 (id formula anchor) refused, the rest deleted",
    pickups().includes("PK2") && !pickups().includes("PK9") && res.skipped.some((s) => s.row === 2));
}
reset();
{
  const res = await bulkDeleteConfigRows({ targets: [t(9), { row: 10, expectPickup: "PK999" }] });
  ok("a moved row is not deleted", pickups().includes("PK10") && !pickups().includes("PK9") && res.skipped[0]?.row === 10);
}

// ── replace driver: name by name ──────────────────────────────────────────────
reset();
{
  const rows = [t(3), t(5), t(4)];                      // 3: "A, C" (smart)  5: A  4: C
  const res = await replaceConfigDriver({ from: A, to: B, targets: rows });
  ok("smart row keeps its other driver", grid[2][3] === `${B}, ${C}`);
  ok("fixed row swapped", grid[4][3] === B);
  ok("row without A skipped, untouched", grid[3][3] === C && res.skipped.some((s) => s.row === 4));
  ok("3 calls total", calls.get + calls.batchGet + calls.write === 3, JSON.stringify(calls));
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
