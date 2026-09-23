/**
 * PSC closing hours — the decision, offline. See src/lib/psc-closing.ts.
 *
 *   0. Only from 19:00, Monday to Saturday.
 *   1. A PSC past its closing_time sends the job to its next_best_psc, skipping
 *      ones that have closed too.
 *   2. A job diverted on an earlier day goes BACK to its own PSC once that PSC is
 *      open — and stays put if it is still closed.
 *   3. Nothing open anywhere → the job is left exactly where it is.
 *   4. A person's later edit wins over the record; alt_drop_off_id needs no record.
 *
 * Run: npx tsx scripts/psc-closing.test.mts
 */
import { buildPscTable, isClosingWindow, parseClosingTime, planDropoff, resolveOpenDropoff, PSC_TABLE, type DropoffSwapRecord } from "../src/lib/psc-closing";
import { PSC_CLOSING, PSC_ROUTES } from "../src/lib/psc-routes-data";

let failures = 0;
function ok(label: string, cond: boolean) {
  console.log(`  ${cond ? "ok  " : "FAIL"}   ${label}`);
  if (!cond) failures++;
}

const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const D001 = uid(1), D004 = uid(4), D007 = uid(7), D014 = uid(14), D015 = uid(15), D021 = uid(21), D036 = uid(36);
const CLINIC = uid(99999);

// Shaped like the real inputs: the PSC list (psc_pickup / pickup) and PSC_CLOSING.
const pscs = [
  { psc_pickup: "BRA - D001", pickup: D001 },
  { psc_pickup: "BRA - D004", pickup: D004 },
  { psc_pickup: "BRA - D007", pickup: D007 },
  { psc_pickup: "BRA - D014", pickup: D014 },
  { psc_pickup: "BRA - D015", pickup: D015 },
  { psc_pickup: "BRA - D021", pickup: D021 },
  { psc_pickup: "BRA - D036", pickup: D036 },
  { psc_pickup: "BRA - D036", pickup: D036 },   // D036 has two routes
];
const { table, unresolved } = buildPscTable(pscs, {
  D004: { close: "20:00", next: "D001" },
  D007: { close: "21h", next: "D001" },
  D014: { close: "19:30", next: "D007" },
  D015: { close: "19h30", next: "d004" },
  D021: { close: "19:00" },
  D036: { close: "19:45", next: "D099" },       // D099 is no PSC
  D098: { close: "19:00" },                     // nor is D098
});
const at = (hhmm: string) => parseClosingTime(hhmm)!;
const base = { table, altId: "", record: null, pickupId: CLINIC, today: "2026-09-23", exempt: false };

console.log("\nparseClosingTime");
ok("20:00", parseClosingTime("20:00") === 1200);
ok("20h30", parseClosingTime("20h30") === 1230);
ok("20h", parseClosingTime("20h") === 1200);
ok("20:00:00", parseClosingTime("20:00:00") === 1200);
ok("blank = never closes", parseClosingTime("") === null);
ok("00:00 = never closes, not closed all day", parseClosingTime("00:00") === null);
ok("24:00 = never closes", parseClosingTime("24:00") === null);
ok("garbage fails OPEN", parseClosingTime("tối") === null);

console.log("\nwindow: 19:00, Monday to Saturday");
const vn = (iso: string) => new Date(`${iso}+07:00`);
ok("Tue 18:59 → not yet", !isClosingWindow(vn("2026-09-22T18:59:00")));
ok("Tue 19:00 → on", isClosingWindow(vn("2026-09-22T19:00:00")));
ok("Sat 21:30 → on", isClosingWindow(vn("2026-09-26T21:30:00")));
ok("Sun 21:30 → off all day", !isClosingWindow(vn("2026-09-27T21:30:00")));
ok("Mon 07:00 → off", !isClosingWindow(vn("2026-09-28T07:00:00")));

console.log("\ntable");
ok("unlisted PSC (D001) never closes", !table.has(D001));
ok("a PSC on two routes appears once", table.size === 6);
ok("next best by code, any case", table.get(D004)!.hubId === D001 && table.get(D015)!.hubId === D004);
ok("unknown codes are reported", unresolved.length === 2 && unresolved.some((u) => u.includes("D099")) && unresolved.includes("D098"));
ok("…and an unknown next best counts as none", table.get(D036)!.hubId === "");

console.log("\nthe real table (PSC_CLOSING)");
{
  const real = buildPscTable(PSC_ROUTES, PSC_CLOSING);
  ok(`every code and next best is a real PSC${real.unresolved.length ? ` — ${real.unresolved.join(", ")}` : ""}`, real.unresolved.length === 0);
  ok("every listed PSC made it into the table", PSC_TABLE.size === Object.keys(PSC_CLOSING).length);
  const id = (code: string) => PSC_ROUTES.find((r) => r.psc_pickup === `BRA - ${code}`)!.pickup;
  const go = (code: string, hhmm: string) => {
    const r = resolveOpenDropoff(PSC_TABLE, id(code), at(hhmm), CLINIC).id;
    return r ? PSC_ROUTES.find((x) => x.pickup === r)!.psc_pickup.slice(6) : null;
  };
  ok("18:59 D026 stays", go("D026", "18:59") === "D026");
  ok("19:00 D026 → D002", go("D026", "19:00") === "D002");
  ok("19:00 D022 → D003", go("D022", "19:00") === "D003");
  ok("19:00 D046 → D029", go("D046", "19:00") === "D029");
  ok("19:00 D014 has no next best → left alone", go("D014", "19:00") === null);
  ok("19:00 D001 still open", go("D001", "19:00") === "D001");
  ok("21:00 D026 → D002 closed too, nothing after → left alone", go("D026", "21:00") === null);
  ok("D030 / D052 never close", go("D030", "21:30") === "D030" && go("D052", "21:30") === "D052");
}

console.log("\nresolveOpenDropoff");
ok("open PSC is its own answer", resolveOpenDropoff(table, D014, at("19:29"), CLINIC).id === D014);
ok("closes AT the minute", resolveOpenDropoff(table, D014, at("19:30"), CLINIC).id === D007);
ok("closed hub skipped: D014 → D007 (shut) → D001", resolveOpenDropoff(table, D014, at("21:05"), CLINIC).id === D001);
ok("two-hop chain: D015 → D004 → D001", resolveOpenDropoff(table, D015, at("20:10"), CLINIC).id === D001);
ok("no next best and closed → nothing open", resolveOpenDropoff(table, D021, at("19:10"), CLINIC).id === null);
ok("never routes to the job's own pickup", resolveOpenDropoff(table, D014, at("20:00"), D007).id === null);
ok("non-PSC destination untouched", resolveOpenDropoff(table, "id-3pl", at("23:00"), CLINIC).id === "id-3pl");
ok("outside the window the engine passes an empty table: all open", resolveOpenDropoff(new Map(), D014, at("21:00"), CLINIC).id === D014);

console.log("\nplanDropoff — the swap");
{
  const p = planDropoff({ ...base, currentId: D014, nowMin: at("19:45") });
  ok("closed → moved to D007", p.targetId === D007 && p.reason === "closed");
  ok("original remembered", typeof p.record === "object" && p.record?.set.from === D014 && p.record.set.to === D007);
}
{
  const p = planDropoff({ ...base, currentId: D014, nowMin: at("15:00") });
  ok("open → nothing to do, nothing written", p.targetId === D014 && p.reason === "keep" && p.record === null);
}
{
  const p = planDropoff({ ...base, currentId: D014, nowMin: at("15:00"), exempt: true });
  ok("exempt legs are never moved", p.targetId === D014 && p.reason === "keep");
}
{
  const p = planDropoff({ ...base, currentId: D014, nowMin: at("21:00"), exempt: true });
  ok("…even after closing", p.targetId === D014 && p.record === null);
}

console.log("\nplanDropoff — the way back");
const rec: DropoffSwapRecord = { from: D014, to: D007, on: "2026-09-22" };
{
  const p = planDropoff({ ...base, table: new Map(), currentId: D007, record: rec, nowMin: at("07:00") });
  ok("carried into the next morning (empty table) → back to D014", p.targetId === D014 && p.reason === "revert");
  ok("record dropped after revert", p.record === "delete");
}
{
  const p = planDropoff({ ...base, currentId: D007, record: rec, nowMin: at("19:50") });
  ok("re-dated to after closing → stays on D007", p.targetId === D007 && p.reason === "closed");
  ok("identical record is not rewritten every cycle", p.record === null);
}
{
  const p = planDropoff({ ...base, currentId: D007, record: rec, nowMin: at("21:10") });
  ok("original AND its hub shut → re-routed from the ORIGINAL (D001)", p.targetId === D001 && p.reason === "closed");
  ok("record still names the original", typeof p.record === "object" && p.record?.set.from === D014 && p.record.set.to === D001);
}
{
  const p = planDropoff({ ...base, currentId: "id-d018", record: rec, nowMin: at("07:00") });
  ok("a person moved it by hand since → their choice wins", p.targetId === "id-d018" && p.reason === "keep");
  ok("…and the stale record is dropped", p.record === "delete");
}

console.log("\nplanDropoff — nothing open");
{
  const p = planDropoff({ ...base, currentId: D021, nowMin: at("19:05") });
  ok("no next best → left exactly where it is", p.targetId === D021 && p.reason === "all_closed" && p.record === null);
}
{
  // Hypothetical: D001 gets a closing time too, and everything on D014's chain is shut.
  const shut = buildPscTable(pscs, {
    D001: { close: "22:00" },
    D007: { close: "21:00", next: "D001" },
    D014: { close: "19:30", next: "D007" },
  }).table;
  const p = planDropoff({ ...base, table: shut, currentId: D007, record: rec, nowMin: at("22:30") });
  ok("a diverted job is NOT sent back to a PSC that is itself closed", p.targetId === D007 && p.reason === "all_closed");
  ok("…and keeps its record for tomorrow", p.record === null);
}

console.log("\nplanDropoff — alt_drop_off_id");
{
  const p = planDropoff({ ...base, currentId: CLINIC, altId: D014, nowMin: at("10:00") });
  ok("alt applies as before while open", p.targetId === D014 && p.reason === "alt" && p.record === null);
}
{
  const p = planDropoff({ ...base, currentId: CLINIC, altId: D014, nowMin: at("20:00") });
  ok("closed alt target → its hub", p.targetId === D007 && p.reason === "closed");
  ok("no record: alt re-derives itself on the next assign", p.record === null);
}
{
  const p = planDropoff({ ...base, currentId: D007, altId: D014, nowMin: at("08:00") });
  ok("next day the alt row puts it back by itself", p.targetId === D014 && p.reason === "alt");
}

console.log(failures === 0 ? "\nall passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
