// Run: npx tsx scripts/leave-gen.test.mts — fake Redis + fake Supabase, no network.
// A warm instance re-reads the ~316 KB leave blob only when the leave:gen stamp moves,
// or after the 1h backstop — never on the plain 5-minute clock it used to.
import assert from "node:assert/strict";
import { vnDate } from "../src/lib/time";

process.env.KV_REST_API_URL = "https://leave-gen.test";
process.env.KV_REST_API_TOKEN = "test";
process.env.SUPABASE_URL = "https://supabase.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test";

const store = new Map<string, string>();
const L2 = "leave:master:v1:entries";
let l2Reads = 0;
let dbReads = 0;
let leaveFrom = vnDate();

function command([name, key, ...args]: string[]): unknown {
  switch (name.toUpperCase()) {
    case "GET": if (key === L2) l2Reads++; return store.get(key) ?? null;
    case "SET": store.set(key, args[0]); return "OK";
    case "DEL": return store.delete(key) ? 1 : 0;
    default: throw new Error(`Unexpected Redis command: ${name}`);
  }
}

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://leave-gen.test")) {
    const body = JSON.parse(String(init?.body));
    const batched = Array.isArray(body[0]);
    const encode = (v: unknown): unknown => typeof v === "string" && v !== "OK" ? Buffer.from(v).toString("base64") : v;
    const results = (batched ? body : [body]).map((c: unknown[]) => ({ result: encode(command(c.map(String))) }));
    return Response.json(batched ? results : results[0]);
  }
  assert.ok(url.startsWith("https://supabase.invalid/rest/v1/"), `Unexpected request: ${url}`);
  if (url.includes("master_drivers")) return Response.json([{ driver_id: "00000000-0000-0000-0000-000000000001", first_name: "An", last_name: "", roster: { Driver: "DC100001 An" } }]);
  assert.ok(url.includes("master_leave_read"), `Unexpected request: ${url}`);
  dbReads++;
  return Response.json([{ id: 1, source_uid: "x", source_row: 2, revision: 1, row_data: { "Loại Nghỉ": "Nghỉ phép" },
    linked_driver_id: "00000000-0000-0000-0000-000000000001", starts_on: leaveFrom, ends_on: leaveFrom,
    starts_at: null, ends_at: null, master_leave_substitutes: [] }]);
};

let now = Date.now();
Date.now = () => now;
const minutes = (m: number) => { now += m * 60_000; };
const { loadLeaveEntries, invalidateLeaveCache } = await import("../src/lib/leave-config");

await loadLeaveEntries();
assert.equal(dbReads, 1, "first load reads Supabase");
const firstReads = l2Reads; // the cold load checks the blob once before Supabase

minutes(6);
await loadLeaveEntries();
assert.equal(l2Reads, firstReads, "past the 5-min clock with the stamp unchanged: no blob re-read");
assert.equal(dbReads, 1);

// Another instance files leave: it moves the stamp and drops the blob.
leaveFrom = "2099-01-01";
store.set("leave:gen", "moved");
store.delete(L2);
minutes(6);
const after = await loadLeaveEntries();
assert.equal(dbReads, 2, "a moved stamp reloads");
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
