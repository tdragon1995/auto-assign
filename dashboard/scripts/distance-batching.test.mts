/**
 * How many HTTP requests a day's legs actually cost.
 *
 * This is the test that should have existed before a second provider was added.
 * Grouping route legs by ORIGIN looks obviously right and is wrong for this shape
 * of data: a driver's day chains A→B, B→C, C→lab, so consecutive legs share no
 * origin and a clinic starts exactly one leg. Every leg then became its own
 * request — measured in production as one call carrying 66 destinations followed
 * by dozens carrying exactly one. Five backfill passes over 50 days turned ~250
 * pairs a day into tens of thousands of requests and exhausted the quota.
 *
 * The repetition lives at the DESTINATION end: most legs finish at the lab.
 *
 * No Redis and no real network: every lookup is a miss, and fetch is counted.
 *
 *   npx tsx scripts/distance-batching.test.mts
 */
process.env.GOONG_API_KEY = "TEST-KEY";
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

let calls: { origins: number; dests: number }[] = [];
globalThis.fetch = (async (u: string | URL | Request) => {
  const url = new URL(String(u));
  const nOrigins = (url.searchParams.get("origins") ?? "").split("|").filter(Boolean).length;
  const nDests = (url.searchParams.get("destinations") ?? "").split("|").filter(Boolean).length;
  calls.push({ origins: nOrigins, dests: nDests });
  // Goong shape: one row per origin, one element per destination.
  const rows = Array.from({ length: nOrigins }, () => ({
    elements: Array.from({ length: nDests }, () => ({
      status: "OK", distance: { value: 3000 }, duration: { value: 600 },
    })),
  }));
  return new Response(JSON.stringify({ rows }), { status: 200 });
}) as typeof fetch;

const { roadDistancesForPairs } = await import("../src/lib/distance-cache");

const LAB = { lat: 10.7700, lon: 106.6600 };
const clinic = (i: number) => ({ lat: 10.78 + i / 1000, lon: 106.68 + i / 1000 });

// A realistic day: 20 drivers each collect at one clinic and run to the lab, and
// a handful of clinic-to-clinic hops in between. 25 pairs, 21 distinct origins.
const pairs = [
  ...Array.from({ length: 20 }, (_, i) => ({ from: clinic(i), to: LAB })),
  ...Array.from({ length: 5 }, (_, i) => ({ from: clinic(i), to: clinic(i + 30) })),
];

calls = [];
const res = await roadDistancesForPairs(pairs);

check("every pair still gets an answer", res.length === 25 && res.every((r) => r?.distance_km === 3),
  `${res.filter((r) => r).length}/25 resolved`);

// Grouped by origin this is 20 single-destination calls plus 5 more sharing those
// origins — roughly one request per leg. Grouped by destination the lab collapses
// into one.
check(
  "the 20 lab-bound legs collapse into ONE request",
  calls.some((c) => c.origins === 20 && c.dests === 1),
  JSON.stringify(calls),
);
check(
  `total requests stay in single figures (was ~1 per leg) — got ${calls.length}`,
  calls.length <= 8,
  JSON.stringify(calls),
);
check("no request is a wasteful 1x1 when it could batch", calls.filter((c) => c.origins === 1 && c.dests === 1).length <= 5);

// A day with no shared destinations must still work, just without the saving.
calls = [];
const chained = Array.from({ length: 6 }, (_, i) => ({ from: clinic(i), to: clinic(i + 50) }));
const res2 = await roadDistancesForPairs(chained);
check("all-unique pairs still resolve", res2.every((r) => r?.distance_km === 3));
check("and fall back to per-origin grouping", calls.length === 6, JSON.stringify(calls));

console.log(failures === 0 ? "\nAll batching checks passed." : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
