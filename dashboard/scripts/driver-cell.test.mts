/**
 * Pins that the config "Driver" cell may name SEVERAL drivers.
 *
 * One name is a fixed rule; several, comma-separated, is a smart row — the id
 * column beside it resolves each in turn and the engine gives the job to whoever
 * is nearest. ~218 rows are shaped like that today.
 *
 * The editor's first outing read the cell as a single name and refused every one
 * of them, which did more damage than it looks: a smart branch could not be
 * OPENED, so its hours could not be edited either. A cell nobody was trying to
 * change blocked a change that had nothing to do with drivers.
 *
 *   npx tsx scripts/driver-cell.test.mts
 */
import type { ConfigDriver } from "../src/lib/types";
const { resolveDriverCell, splitDriverNames } = await import("../src/lib/driver-cell");

let failed = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) return console.log(`  ok   ${label}`);
  failed++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
}

const NHAT = "F - P - DC101569 Nguyễn Minh Nhật";
const DUC  = "F - P - DC100075 Nguyễn Thế Đức";
const THANH = "P - P - PT101235 Bùi Ngọc Thành";
const roster: ConfigDriver[] = [NHAT, DUC, THANH].map((name, i) => ({ driver_id: `id${i}`, name }));

const name = (r: ReturnType<typeof resolveDriverCell>) => ("name" in r ? r.name : null);
const err  = (r: ReturnType<typeof resolveDriverCell>) => ("error" in r ? r.error : null);

// The row that could not be opened at all.
{
  const r = resolveDriverCell(`${NHAT}, ${DUC}`, roster);
  ok("a two-driver cell resolves", name(r) === `${NHAT}, ${DUC}`, `got ${JSON.stringify(r)}`);
}
ok("...and three", name(resolveDriverCell(`${NHAT}, ${DUC}, ${THANH}`, roster)) === `${NHAT}, ${DUC}, ${THANH}`);
ok("one name still resolves", name(resolveDriverCell(DUC, roster)) === DUC);

// Rebuilt from the roster's spelling, which is what the sheet's lookup matches.
ok("a short form is expanded to the roster's spelling",
   name(resolveDriverCell("minh nhat, the duc", roster)) === `${NHAT}, ${DUC}`);
ok("separator is normalised to ', '",
   name(resolveDriverCell(`${NHAT},${DUC}`, roster)) === `${NHAT}, ${DUC}`);
ok("a trailing comma is not a second, empty driver",
   name(resolveDriverCell(`${DUC}, `, roster)) === DUC);

// Errors have to say WHICH name is wrong.
{
  const r = resolveDriverCell(`${NHAT}, Trần Văn Ai Đó`, roster);
  ok("an unknown name is refused", err(r) !== null);
  ok("...naming only the offending part", (err(r) ?? "").includes("Trần Văn Ai Đó"));
  ok("...not the whole cell", !(err(r) ?? "").includes(NHAT));
}
ok("an ambiguous part is refused", (err(resolveDriverCell("Nguyễn", roster)) ?? "").includes("khớp 2"));
ok("the same driver twice is refused", (err(resolveDriverCell(`${DUC}, ${DUC}`, roster)) ?? "").includes("lặp lại"));
ok("an empty cell is refused", err(resolveDriverCell("   ", roster)) === "Chưa chọn tài xế");
ok("a lone comma is an empty cell", err(resolveDriverCell(" , ", roster)) === "Chưa chọn tài xế");

// What the write routes validate against.
{
  const parts = splitDriverNames(`${NHAT},  ${DUC} ,`);
  ok("the cell splits into its names", parts.length === 2, `got ${JSON.stringify(parts)}`);
  ok("...trimmed", parts[1] === DUC);
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
