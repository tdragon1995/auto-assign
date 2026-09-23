/**
 * PSC closing hours — the decision, offline. See src/lib/psc-closing.ts.
 *
 *   1. A PSC past its closing_time sends the job down its own chain (the PSC row's
 *      dropoff_id), skipping hubs that have closed too.
 *   2. A job diverted on an earlier day goes BACK to its own PSC once that PSC is
 *      open — and stays put if it is still closed.
 *   3. Nothing open anywhere → the job is left exactly where it is.
 *   4. A person's later edit wins over the record; alt_drop_off_id needs no record.
 *
 * Run: npx tsx scripts/psc-closing.test.mts
 */
import { buildPscTable, parseClosingTime, planDropoff, resolveOpenDropoff, type DropoffSwapRecord } from "../src/lib/psc-closing";

let failures = 0;
function ok(label: string, cond: boolean) {
  console.log(`  ${cond ? "ok  " : "FAIL"}   ${label}`);
  if (!cond) failures++;
}

const D001 = "id-d001", D004 = "id-d004", D007 = "id-d007", D014 = "id-d014", D015 = "id-d015", D021 = "id-d021";
const CLINIC = "id-clinic";

// Shaped like the live Location Table: a PSC row's dropoff_id is its hub.
const table = buildPscTable([
  { customer_name: "BRA - D001", customer_id: D001, dropoff_id: D001, closing_time: "" },
  { customer_name: "BRA - D004", customer_id: D004, dropoff_id: D001, closing_time: "20:00" },
  { customer_name: "BRA - D007", customer_id: D007, dropoff_id: D001, closing_time: "21h" },
  { customer_name: "BRA - D014", customer_id: D014, dropoff_id: D007, closing_time: "19:30" },
  { customer_name: "BRA - D015", customer_id: D015, dropoff_id: D004, closing_time: "17h30" },
  { customer_name: "BRA - D021", customer_id: D021, dropoff_id: D021, closing_time: "18:00" },
  { customer_name: "12345 - Q1 - PK ABC", customer_id: CLINIC, dropoff_id: D014, closing_time: "10:00" },
]);
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

console.log("\ntable");
ok("client rows are not PSCs", !table.has(CLINIC));
ok("a self-hub ends the chain", table.get(D001)!.hubId === "");

console.log("\nresolveOpenDropoff");
ok("open PSC is its own answer", resolveOpenDropoff(table, D014, at("19:29"), CLINIC).id === D014);
ok("closes AT the minute", resolveOpenDropoff(table, D014, at("19:30"), CLINIC).id === D007);
ok("closed hub skipped: D014 → D007 (shut) → D001", resolveOpenDropoff(table, D014, at("21:05"), CLINIC).id === D001);
ok("two-hop chain: D015 → D004 → D001", resolveOpenDropoff(table, D015, at("20:10"), CLINIC).id === D001);
ok("terminal PSC closed → nothing open", resolveOpenDropoff(table, D021, at("18:30"), CLINIC).id === null);
ok("never routes to the job's own pickup", resolveOpenDropoff(table, D014, at("20:00"), D007).id === null);
ok("non-PSC destination untouched", resolveOpenDropoff(table, "id-3pl", at("23:00"), CLINIC).id === "id-3pl");

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
  const p = planDropoff({ ...base, currentId: D007, record: rec, nowMin: at("07:00") });
  ok("carried into the next morning → back to D014", p.targetId === D014 && p.reason === "revert");
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
  const p = planDropoff({ ...base, currentId: D021, nowMin: at("19:00") });
  ok("terminal closed → left exactly where it is", p.targetId === D021 && p.reason === "all_closed" && p.record === null);
}
{
  // Hypothetical: D001 gets a closing time too, and everything on D014's chain is shut.
  const shut = buildPscTable([
    { customer_name: "BRA - D001", customer_id: D001, dropoff_id: D001, closing_time: "22:00" },
    { customer_name: "BRA - D007", customer_id: D007, dropoff_id: D001, closing_time: "21:00" },
    { customer_name: "BRA - D014", customer_id: D014, dropoff_id: D007, closing_time: "19:30" },
  ]);
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
