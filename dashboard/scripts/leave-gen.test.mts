// Run: npx tsx scripts/leave-gen.test.mts — fake Redis + fake sheet, no network.
// A warm instance re-reads the ~316 KB leave blob only when the leave:gen stamp moves,
// or after the 1h backstop — never on the plain 5-minute clock it used to.
import assert from "node:assert/strict";
import { SHEET_GID } from "../src/lib/sheets";
import { vnDate } from "../src/lib/time";

process.env.KV_REST_API_URL = "https://leave-gen.test";
process.env.KV_REST_API_TOKEN = "test";
process.env.MASTER_CLIENT_INFO_SOURCE = "sheet";
process.env.LEAVE_NAME_RECOVERY = "0";

const store = new Map<string, string>();
const L2 = "leave:v3:entries";
let l2Reads = 0;
let sheetReads = 0;
let leaveFrom = vnDate();

function command([name, key, ...args]: string[]): unknown {
  switch (name.toUpperCase()) {
    case "GET": if (key === L2) l2Reads++; return store.get(key) ?? null;
    case "SET": store.set(key, args[0]); return "OK";
    case "DEL": return store.delete(key) ? 1 : 0;
    default: throw new Error(`Unexpected Redis command: ${name}`);
  }
}

const csv = (rows: string[][]) => rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://leave-gen.test")) {
    const body = JSON.parse(String(init?.body));
    const batched = Array.isArray(body[0]);
    const encode = (v: unknown): unknown => typeof v === "string" && v !== "OK" ? Buffer.from(v).toString("base64") : v;
    const results = (batched ? body : [body]).map((c: unknown[]) => ({ result: encode(command(c.map(String))) }));
    return Response.json(batched ? results : results[0]);
  }
  assert.ok(url.includes(`gid=${SHEET_GID.nghi_phep}`), `Unexpected request: ${url}`);
  sheetReads++;
  return new Response(csv([
    ["driver_id", "driver", "Loại Nghỉ", "leave_from", "leave_to", "leave_from_hr", "leave_to_hr", "note"],
    ["00000000-0000-0000-0000-000000000001", "DC100001 An", "Nghỉ phép", leaveFrom, leaveFrom, "", "", ""],
  ]), { headers: { "content-type": "text/csv" } });
};

let now = Date.now();
Date.now = () => now;
const minutes = (m: number) => { now += m * 60_000; };
const { loadLeaveEntries, invalidateLeaveCache } = await import("../src/lib/leave-config");

await loadLeaveEntries();
assert.equal(sheetReads, 1, "first load reads the sheet");
const firstReads = l2Reads; // the cold load checks the blob once before the sheet

minutes(6);
await loadLeaveEntries();
assert.equal(l2Reads, firstReads, "past the 5-min clock with the stamp unchanged: no blob re-read");
assert.equal(sheetReads, 1);

// Another instance files leave: it moves the stamp and drops the blob.
leaveFrom = "2099-01-01";
store.set("leave:gen", "moved");
store.delete(L2);
minutes(6);
const after = await loadLeaveEntries();
assert.equal(sheetReads, 2, "a moved stamp reloads");
assert.equal(after[0]?.leave_from, "2099-01-01", "and serves the new leave");

const reads = l2Reads;
minutes(30);
await loadLeaveEntries();
assert.equal(l2Reads, reads, "still unchanged at 36 min: no blob re-read");
minutes(31);
await loadLeaveEntries();
assert.equal(l2Reads, reads + 1, "past the 1h backstop the blob is re-read even with no stamp change");

// Our own invalidation moves the stamp too, so other instances notice.
await invalidateLeaveCache();
assert.notEqual(store.get("leave:gen"), "moved", "invalidateLeaveCache moves the stamp");
assert.equal(store.has(L2), false, "and drops the blob");

console.log("PASS: leave blob re-read only on a stamp change or the 1h backstop");
