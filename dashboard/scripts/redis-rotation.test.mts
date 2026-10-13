// Run: npx tsx scripts/redis-rotation.test.mts — fake Upstash x3 + fake Supabase, no network.
// The shared client moves to the next database when the active one answers "plan limit",
// records the move in redis_rotation, follows a move another instance made, and never
// drifts back to an earlier database on its own.
import assert from "node:assert/strict";

process.env.KV_REST_API_URL = "https://db1.test";
process.env.KV_REST_API_TOKEN = "t1";
process.env.KV_REST_API_URL_2 = "https://db2.test";
process.env.KV_REST_API_TOKEN_2 = "t2";
process.env.KV_REST_API_URL_3 = "https://db3.test";
process.env.KV_REST_API_TOKEN_3 = "t3";
process.env.SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "k";

const stores: Record<string, Map<string, string>> = { db1: new Map(), db2: new Map(), db3: new Map() };
const blocked = new Set<string>();
let pointer = 0;
const hits: string[] = [];

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "sb.test") {
    if (init?.method === "PATCH") {
      const from = Number(/active=eq\.(\d+)/.exec(url.search)![1]);
      if (from !== pointer) return Response.json([]);
      pointer = JSON.parse(String(init.body)).active;
      return Response.json([{ active: pointer }]);
    }
    return Response.json([{ active: pointer }]);
  }
  const db = url.hostname.split(".")[0];
  hits.push(db);
  if (blocked.has(db)) {
    return Response.json({ error: "ERR This database has reached current Fixed plan limits. Please upgrade manually" }, { status: 403 });
  }
  const [name, key, value] = JSON.parse(String(init?.body)) as string[];
  const s = stores[db];
  const result = name.toUpperCase() === "SET" ? (s.set(key, value), "OK")
    : name.toUpperCase() === "DEL" ? (s.delete(key) ? 1 : 0)
    : s.get(key) ?? null;
  return Response.json({ result });
};

let now = Date.now();
Date.now = () => now;
const { sharedRedis } = await import("../src/lib/redis");
const redis = sharedRedis()!;

await redis.set("k", "one");
assert.equal(stores.db1.get("k"), "one", "starts on #1");

// #1 fills up: the same call lands on #2, the pointer moves, the stale off-hold is cleared.
stores.db2.set("assign:arm_hold", "1");
blocked.add("db1");
await redis.set("k", "two");
assert.equal(stores.db2.get("k"), "two", "retried on #2");
assert.equal(pointer, 1, "switch recorded");
assert.equal(stores.db2.has("assign:arm_hold"), false, "stale manual-off hold cleared on the new database");

// #1 resets: we stay on #2 — no drifting back.
blocked.delete("db1");
now += 60_000;
await redis.set("k", "three");
assert.equal(stores.db2.get("k"), "three", "stays on #2 after #1 resets");

// Another instance moved the pointer to #3: we follow once our cached read expires.
pointer = 2;
now += 31_000;
await redis.set("k", "four");
assert.equal(stores.db3.get("k"), "four", "follows a move made elsewhere");

// #3 fills: wraps around to #1.
blocked.add("db3");
await redis.set("k", "five");
assert.equal(stores.db1.get("k"), "five", "wraps 3 -> 1");
assert.equal(pointer, 0);

// Everything full: the error surfaces instead of looping.
blocked.add("db1"); blocked.add("db2");
await assert.rejects(redis.get("k"), /plan limits/);
const calls = hits.length;
await assert.rejects(redis.get("k"), /plan limits/);
assert.equal(hits.length, calls, "all full: fail fast for a minute, no walking the databases");

// A non-limit error is not a reason to switch.
blocked.clear();
pointer = 0; now += 61_000;
const before = pointer;
globalThis.fetch = async () => Response.json({ error: "WRONGTYPE Operation against a key" }, { status: 400 });
await assert.rejects(redis.get("k"), /WRONGTYPE/);
assert.equal(pointer, before, "ordinary errors do not rotate");

console.log("PASS: rotation on plan limit, shared pointer, no drift back, wrap-around, no rotate on other errors");
