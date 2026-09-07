/**
 * Does a distance answered by the FALLBACK get written to the shared cache?
 *
 * This is the whole economics of the fallback. If a fallback's answers were not
 * cached, every future pass would re-ask for the same pairs forever — the exact
 * trap the ~13,000 unpriced legs were already stuck in, just with a different
 * provider's bill attached. Caching is what makes a single recovery pass permanent.
 *
 * It works because the whole chain sits INSIDE the fetch-misses callback, below
 * the caching layer, rather than wrapping it — so the cache cannot tell which
 * provider answered and stores any of them identically. That is easy to break by
 * "simplifying" a fallback upward, hence this test.
 *
 * VIETMAP IS NOW THE LEAD, so the fallback under test here is GOONG: the lead is
 * made to refuse and the pairs must still resolve, still be marked `api`, and
 * still land in the cache. Which provider sits in which slot is deliberately not
 * what this file asserts — distance-chain.test.mts owns the order. What it
 * asserts is that the slot makes no difference to the cache, which is the
 * property that has to survive every future reordering.
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
/** The lead refuses, so every answer below comes from a FALLBACK slot. */
let vietmapDown = true;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
  const url = String(u);
  // Let the Redis stub through untouched.
  if (url.includes("127.0.0.1")) return realFetch(u as string, init);

  if (url.includes("vietmap")) {
    vietmapCalls++;
    // The LEAD, exhausted — so the chain has to fall through to Goong.
    if (vietmapDown) return new Response("rate limited", { status: 429 });
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
  goongCalls++;
  // Goong's two shapes: rows are ORIGINS, columns are destinations. These pairs are
  // N origins → 1 destination, so the reply must be N rows of one element — the
  // 1xN shape parses as a length mismatch and returns all-null, which reads exactly
  // like a provider outage and cost an afternoon the last time it was assumed.
  const q = new URL(url).searchParams;
  const rows = (q.get("origins") ?? "").split("|").filter(Boolean).length || 1;
  const cols = (q.get("destinations") ?? "").split("|").filter(Boolean).length || 1;
  const el = () => ({ status: "OK", distance: { value: 4321 }, duration: { value: 900 } });
  return new Response(JSON.stringify({
    rows: Array.from({ length: rows }, () => ({ elements: Array.from({ length: cols }, el) })),
  }), { status: 200 });
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

// ── First pass: the lead refuses, a fallback answers ────────────────────────
const first = await roadDistancesForPairs(pairs);
check("both pairs resolved despite the lead being down", first.every((r) => r?.distance_km === 4.3),
  JSON.stringify(first));
check("the answers came from the API path", first.every((r) => r?.source === "api"));
check("the lead was actually asked and refused", vietmapCalls > 0);
check("the fallback was actually used", goongCalls > 0);
check("duration survived the fallback too", first.every((r) => r?.eta_mins === 15));

const keys = await redis.keys("dist:v1:*");
check(`fallback answers were WRITTEN to the shared cache (${keys.length} keys)`, keys.length === 2,
  JSON.stringify(keys));

// The cache must not care WHICH provider answered — that is the property that has
// to hold through any reordering of the chain.
check("and are indistinguishable from a lead-answered pair",
  first.every((r) => r?.source === "api" && r?.eta_mins === 15));

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
