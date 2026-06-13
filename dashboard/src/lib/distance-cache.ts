import { Redis } from "@upstash/redis";
import { goongMatrix, goongMatrixMultiOrigin, type GoongResult } from "./distance";

/**
 * Redis-backed cache for road distances between fixed locations (customer/PSC
 * coordinates — never live GPS, which only feeds the free haversine pre-rank).
 * Road distances between fixed points change only with the road network, so a
 * long TTL is safe; a cache loss just costs one Goong re-fetch.
 */

const TTL_SECONDS = 40 * 24 * 60 * 60; // 40 days

type Pt = { lat: number; lon: number };

// What we persist per pair: the distance, plus the exact (full-precision)
// coordinates as received from Cartrack / distance-checking. The KEY is
// truncated to 5 dp (below) purely for matching/hit-rate; the VALUE keeps the
// real coords so exports and downstream lookups aren't limited to the grid.
interface StoredDistance extends GoongResult {
  from: Pt;
  to: Pt;
}

function getRedis() {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// Truncate to the 5th decimal (~1 m) — read the digits, do NOT round. Rounding
// half-up split near-identical points across the x.xxxxx5 boundary (one rounds
// up, its neighbour down) into two keys, costing avoidable Goong calls and
// breaking exact-match lookups. Truncation puts the cell edge on the round
// number, so coords differing only past the 5th decimal collapse to one key.
// Mirrors Excel TRUNC(x, 5). toFixed(8) first sheds float noise (…0000002),
// then we cut at 5 decimals without rounding.
function coord(n: number): string {
  const s = n.toFixed(8);
  const dot = s.indexOf(".");
  return s.slice(0, dot + 6); // integer part + "." + 5 digits
}

function distKey(fromLat: number, fromLon: number, toLat: number, toLon: number): string {
  return `dist:v1:${coord(fromLat)},${coord(fromLon)}>${coord(toLat)},${coord(toLon)}`;
}

function samePoint(a: { lat: number; lon: number }, b: { lat: number; lon: number }): boolean {
  return coord(a.lat) === coord(b.lat) && coord(a.lon) === coord(b.lon);
}

/** Batched cache read — one pipelined MGET. Null per miss (or everywhere without Redis). */
async function getCachedDistances(keys: string[]): Promise<(GoongResult | null)[]> {
  if (keys.length === 0) return [];
  const redis = getRedis();
  if (!redis) return keys.map(() => null);
  try {
    const raw = await redis.mget<(GoongResult | string | null)[]>(...keys);
    return keys.map((_, i) => {
      const r = raw[i];
      if (!r) return null;
      const v = (typeof r === "string" ? JSON.parse(r) : r) as GoongResult;
      return typeof v?.distance_km === "number" ? v : null;
    });
  } catch {
    return keys.map(() => null);
  }
}

/** Write-behind after a Goong fetch. Failed lookups (null) must never be cached. */
async function setCachedDistances(entries: { key: string; value: StoredDistance }[]): Promise<void> {
  if (entries.length === 0) return;
  const redis = getRedis();
  if (!redis) return;
  try {
    const pipe = redis.pipeline();
    for (const { key, value } of entries) pipe.set(key, JSON.stringify(value), { ex: TTL_SECONDS });
    await pipe.exec();
  } catch {
    /* cache write is best-effort */
  }
}

/**
 * Shared resolve flow, cheapest source first:
 *   1. self-pair (origin == destination) → 0 km, no lookup at all
 *   2. Redis cache (one pipelined MGET)
 *   3. ONE Goong matrix call for the remaining misses, written back to cache
 * `pairs` may contain duplicates — they're deduped before any lookup and each
 * input position still gets its result. Null = Goong failed for that pair
 * (callers fall back to haversine, exactly as before).
 */
async function resolvePairs(
  pairs: { from: { lat: number; lon: number }; to: { lat: number; lon: number } }[],
  fetchMisses: (missPairs: { from: { lat: number; lon: number }; to: { lat: number; lon: number } }[]) => Promise<(GoongResult | null)[]>,
): Promise<(GoongResult | null)[]> {
  if (pairs.length === 0) return [];

  const keyOf = (p: typeof pairs[number]) => distKey(p.from.lat, p.from.lon, p.to.lat, p.to.lon);
  const indexByKey = new Map<string, number>();
  const unique: typeof pairs = [];
  for (const p of pairs) {
    const k = keyOf(p);
    if (!indexByKey.has(k)) {
      indexByKey.set(k, unique.length);
      unique.push(p);
    }
  }

  const results: (GoongResult | null)[] = new Array(unique.length).fill(null);

  const pending: number[] = [];
  for (let i = 0; i < unique.length; i++) {
    if (samePoint(unique[i].from, unique[i].to)) results[i] = { distance_km: 0, eta_mins: 0 };
    else pending.push(i);
  }

  const cached = await getCachedDistances(pending.map((i) => keyOf(unique[i])));
  const misses: number[] = [];
  cached.forEach((c, j) => {
    if (c) results[pending[j]] = c;
    else misses.push(pending[j]);
  });

  if (misses.length > 0) {
    const fetched = await fetchMisses(misses.map((i) => unique[i]));
    const toStore: { key: string; value: StoredDistance }[] = [];
    fetched.forEach((f, j) => {
      if (!f) return;
      results[misses[j]] = f;
      // Persist the distance keyed by the truncated coords, but store the exact
      // coordinates that produced it (as sent from CT / distance-checking).
      const u = unique[misses[j]];
      toStore.push({ key: keyOf(u), value: { ...f, from: u.from, to: u.to } });
    });
    await setCachedDistances(toStore);
  }

  return pairs.map((p) => results[indexByKey.get(keyOf(p))!]);
}

/** N origins → 1 destination (smart-assign ranking: candidates' ref stops → pickup). */
export async function roadDistancesToPoint(
  origins: { lat: number; lon: number }[],
  dest: { lat: number; lon: number },
  apiKey?: string,
): Promise<(GoongResult | null)[]> {
  return resolvePairs(
    origins.map((o) => ({ from: o, to: dest })),
    (miss) => goongMatrixMultiOrigin(miss.map((m) => m.from), dest, apiKey),
  );
}

/** 1 origin → N destinations (distance-checking: one pickup → its dropoffs). */
export async function roadDistancesFromPoint(
  origin: { lat: number; lon: number },
  dests: { lat: number; lon: number }[],
  apiKey?: string,
): Promise<(GoongResult | null)[]> {
  return resolvePairs(
    dests.map((d) => ({ from: origin, to: d })),
    (miss) => goongMatrix(origin.lat, origin.lon, miss.map((m) => m.to), apiKey),
  );
}
