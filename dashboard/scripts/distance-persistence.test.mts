import assert from "node:assert/strict";
import { roadDistancesForPairs, shortenCachedDistances } from "../src/lib/distance-cache";

process.env.KV_REST_API_URL = "https://redis.invalid";
process.env.KV_REST_API_TOKEN = "test";
process.env.SUPABASE_URL = "https://supabase.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
process.env.GOONG_API_KEY = "test";

const from = { lat: 10.123456789, lon: 106.123456789 };
const to = { lat: 10.987654321, lon: 106.987654321 };
const key = "dist:v1:10.12345,106.12345>10.98765,106.98765";
const value = { distance_km: 12.3456789, eta_mins: 23, from, to };
const redis = new Map<string, string>();
const stored = new Map<string, typeof value>();
let calls: string[] = [];
let failRead = false, failWrite = false, failRedis = false, failMapping = false;
const response = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "redis.invalid") {
    if (failRedis) throw new Error("Redis offline");
    const command = (args: unknown[]): unknown => {
      const [name, ...params] = args as string[];
      if (name.toLowerCase() === "mget") return params.map(k => redis.get(k) ?? null);
      assert.equal(name.toLowerCase(), "set");
      calls.push("redis:set");
      if (!params.includes("nx") || !redis.has(params[0])) redis.set(params[0], params[1]);
      return "OK";
    };
    const body = JSON.parse(String(init?.body));
    return response(url.pathname === "/pipeline" ? body.map((c: unknown[]) => ({ result: command(c) })) : { result: command(body) });
  }
  if (url.hostname === "supabase.invalid") {
    if (init?.method === "POST") {
      calls.push("supabase:write");
      if (failWrite) return response({ message: "unavailable" }, 503);
      const ignore = String((init.headers as Record<string, string>).Prefer).includes("ignore-duplicates");
      for (const row of JSON.parse(String(init.body))) {
        if (!ignore || !stored.has(row.key)) stored.set(row.key, row.value);
      }
      return new Response(null, { status: 204 });
    }
    calls.push("supabase:read");
    if (failRead) return response({ message: "unavailable" }, 503);
    const filter = url.searchParams.get("key")!;
    const keys = JSON.parse(`[${filter.slice(4, -1)}]`) as string[];
    return response(keys.flatMap(key => stored.has(key) ? [{ key, value: stored.get(key) }] : []));
  }
  assert.equal(url.hostname, "rsapi.goong.io");
  calls.push("mapping:read");
  return response({ rows: [{ elements: [{ status: failMapping ? "ZERO_RESULTS" : "OK",
    distance: { value: value.distance_km * 1000 }, duration: { value: value.eta_mins * 60 } }] }] });
};

const lookup = () => roadDistancesForPairs([{ from, to }, { from, to }]);
redis.set(key, JSON.stringify(value));
assert.equal((await lookup())[0]?.distance_km, value.distance_km);
assert.deepEqual(calls, [], "Redis hits must not access Supabase or the mapping API");

redis.clear(); stored.set(key, value); calls = [];
assert.deepEqual((await lookup()).map(r => r?.distance_km), [value.distance_km, value.distance_km]);
assert.deepEqual(calls, ["supabase:read", "redis:set"]);
assert.deepEqual(JSON.parse(redis.get(key)!), value, "Supabase restores precision and exact coordinates");

redis.clear(); stored.clear(); calls = [];
assert.equal((await lookup())[0]?.source, "api");
assert.deepEqual(calls, ["supabase:read", "mapping:read", "supabase:write", "redis:set"]);
assert.deepEqual(stored.get(key), { ...value, distance_km: 12.3 }, "Preserve the mapping parser's existing rounding");

redis.clear(); calls = []; failRedis = true;
assert.equal((await lookup())[0]?.distance_km, stored.get(key)?.distance_km);
assert.deepEqual(calls, ["supabase:read"], "Redis downtime must not force a paid API call");
failRedis = false;

redis.clear(); stored.clear(); calls = []; failWrite = true;
assert.equal((await lookup())[0]?.source, "api", "A persistence outage must not block this result");
assert.equal(redis.size, 0, "Do not hide an unsaved distance behind a permanent cache hit");
failWrite = false;

calls = []; failRead = true;
assert.equal((await lookup())[0]?.source, "api", "A Supabase read failure falls back to the mapping API");
assert.ok(stored.has(key));
failRead = false;

redis.clear(); calls = [];
assert.deepEqual(await shortenCachedDistances([{ key, distance_km: 10, eta_mins: 20 }]), { updated: 1, skipped: 0 });
assert.equal(stored.get(key)?.distance_km, 10);
assert.equal(JSON.parse(redis.get(key)!).distance_km, 10);
assert.deepEqual(await shortenCachedDistances([{ key, distance_km: 11, eta_mins: 21 }]), { updated: 0, skipped: 1 });

redis.clear(); stored.clear(); failMapping = true;
assert.deepEqual(await lookup(), [null, null]);
assert.equal(stored.size, 0); assert.equal(redis.size, 0);
failMapping = false;

calls = [];
assert.equal((await roadDistancesForPairs([{ from, to: from }]))[0]?.source, "self");
assert.deepEqual(calls, []);
console.log("Distance persistence checks passed: cache hits, Supabase fallback, precision, write order, outages, corrections and failed results");
