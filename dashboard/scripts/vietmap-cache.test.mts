/**
 * Does a distance answered by the FALLBACK get written to the shared cache?
 *
 * This is the whole economics of the fallback. If VietMap's answers were not
 * cached, every future pass would re-ask for the same pairs forever — the exact
 * trap the ~13,000 unpriced legs were already stuck in, just with a different
 * provider's bill attached. Caching is what makes a single recovery pass permanent.
 *
 * It works because the fallback sits INSIDE the fetch-misses callback, below the
 * caching layer, rather than wrapping it — so the cache cannot tell which provider
 * answered and stores either identically. That is easy to break by "simplifying"
 * the fallback upward, hence this test.
 *
 *   node scripts/redis-stub.mjs &
 *   npx tsx scripts/vietmap-cache.test.mts
 */
const PORT = Number(process.env.STUB_PORT ?? 8079);
process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${PORT}`;
process.env.UPSTASH_REDIS_REST_TOKEN = "local";
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`;
process.env.KV_REST_API_TOKEN = "local";
process.env.GOONG_API_KEY = "GOONG-KEY";
process.env.VIETMAP_API_KEY = "VIETMAP-KEY";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

let goongCalls = 0, vietmapCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
  const url = String(u);
  // Let the Redis stub through untouched.
  if (url.includes("127.0.0.1")) return realFetch(u as string, init);

  if (url.includes("vietmap")) {
    vietmapCalls++;
    // Shape the reply from sources/destinations, NOT from a guess about which end
    // is which: rows are sources, columns are destinations. Assuming one origin
    // here silently returned a 1xN matrix for an Nx1 request and made the code
    // look broken when the stub was.
    const count = (p: string) => (new RegExp(`${p}=([^&]*)`).exec(url)?.[1] ?? "").split(";").filter(Boolean).length;
    const rows = count("sources"), cols = count("destinations");
    return new Response(JSON.stringify({
      code: "OK",
      distances: Array.from({ length: rows }, () => Array.from({ length: cols }, () => 4321)), // m → 4.3 km
      durations: Array.from({ length: rows }, () => Array.from({ length: cols }, () => 900)),  // s → 15 min
    }), { status: 200 });
  }
  // Goong: exhausted, exactly as production is right now.
  goongCalls++;
  return new Response("rate limited", { status: 429 });
}) as typeof fetch;

const { Redis } = await import("@upstash/redis");
const { roadDistancesForPairs } = await import("../src/lib/distance-cache");
const redis = new Redis({ url: process.env.KV_REST_API_URL!, token: "local" });

const pairs = [
  { from: { lat: 10.781234, lon: 106.681234 }, to: { lat: 10.770001, lon: 106.660001 } },
  { from: { lat: 10.782222, lon: 106.682222 }, to: { lat: 10.770001, lon: 106.660001 } },
];

// Clear any prior run so a stale key cannot fake a pass.
for (const k of await redis.keys("dist:v1:*")) await redis.del(k);

// ── First pass: Goong refuses, VietMap answers ──────────────────────────────
const first = await roadDistancesForPairs(pairs);
check("both pairs resolved despite Goong being down", first.every((r) => r?.distance_km === 4.3),
  JSON.stringify(first));
check("the answers came from the API path", first.every((r) => r?.source === "api"));
check("Goong was actually asked and refused", goongCalls > 0);
check("VietMap was actually used", vietmapCalls > 0);
check("duration survived the fallback too", first.every((r) => r?.eta_mins === 15));

const keys = await redis.keys("dist:v1:*");
check(`fallback answers were WRITTEN to the shared cache (${keys.length} keys)`, keys.length === 2,
  JSON.stringify(keys));

// ── Second pass: nothing should reach either provider ───────────────────────
goongCalls = 0; vietmapCalls = 0;
const second = await roadDistancesForPairs(pairs);
check("second pass served entirely from cache", second.every((r) => r?.source === "cache"),
  JSON.stringify(second.map((r) => r?.source)));
check("no provider was contacted at all the second time", goongCalls === 0 && vietmapCalls === 0,
  `goong=${goongCalls} vietmap=${vietmapCalls}`);
check("cached distance is unchanged", second.every((r) => r?.distance_km === 4.3));

for (const k of await redis.keys("dist:v1:*")) await redis.del(k);
globalThis.fetch = realFetch;
console.log(failures === 0 ? "\nAll fallback-cache checks passed." : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
