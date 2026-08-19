const GOONG_API = "https://rsapi.goong.io/v2/distancematrix";

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/** 1→1 road distance via Goong (motorbike). Returns km, or null if unavailable. */
export async function goongDistanceKm(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
  apiKey?: string
): Promise<number | null> {
  const results = await goongMatrix(fromLat, fromLon, [{ lat: toLat, lon: toLon }], apiKey);
  return results[0]?.distance_km ?? null;
}

export interface GoongResult {
  distance_km: number;
  eta_mins: number;
}

/**
 * Shared mutable flag for daily-quota awareness. Pass the same object across a
 * batch of Goong calls: the first call that hits HTTP 429 (Goong's rate/daily-
 * limit response) flips `quotaExceeded`, and every later call in the batch then
 * short-circuits to all-null WITHOUT a network request. That turns the rest of
 * the run into cache-only resolution (resolvePairs still serves self/cache pairs
 * for free) instead of firing hundreds of doomed requests. Quota failures return
 * null, so nothing is cached — a re-run the next day, once the cap resets, fills
 * exactly the gaps. Optional: existing callers pass nothing and behave as before.
 */
export interface QuotaSignal {
  quotaExceeded: boolean;
}

/**
 * N→1 road distances in ONE request: pipe-separated multi-origin matrix call.
 * Multi-origin is undocumented-but-verified Goong behavior (live-tested
 * 2026-06-12: 2, 5 and 10 origins all returned one row per origin, values
 * identical to the equivalent 1×1 calls). Shape-checked: if the API ever stops
 * returning one row per origin, this fails soft to all-null and callers fall
 * back to haversine — worst case is today's behavior, never breakage.
 */

/**
 * A 429 means "not right now", not "never" — so wait and ask again.
 *
 * Both providers were being treated as if a refusal were a permanent property of
 * the pair: the null was returned, the leg was written unpriced, and because
 * failures are deliberately never cached the same pair was re-asked on the next
 * pass and refused again. A whole 50-day backfill was lost to that twice in one
 * afternoon — once against Goong, then again against the fallback brought in to
 * cover it.
 *
 * Bounded deliberately. Two retries at 600ms and 1800ms cover the burst that a
 * per-second or per-minute limit produces, without risking the archive's 60s
 * ceiling. If it is still refusing after that, the limit is not a burst and the
 * caller should stop asking — which is what the quota signal is for.
 */
export async function fetchRetrying(url: string, attempts = 3): Promise<Response> {
  let res = await fetch(url);
  for (let i = 1; i < attempts && res.status === 429; i++) {
    await new Promise((r) => setTimeout(r, 600 * 3 ** (i - 1)));
    res = await fetch(url);
  }
  return res;
}

export async function goongMatrixMultiOrigin(
  origins: { lat: number; lon: number }[],
  dest: { lat: number; lon: number },
  apiKey: string = process.env.GOONG_API_KEY ?? "",
  signal?: QuotaSignal
): Promise<(GoongResult | null)[]> {
  if (!apiKey || origins.length === 0) return origins.map(() => null);
  // Daily quota already known exhausted — skip the request so the caller falls
  // back to cache-only resolution instead of firing a doomed call.
  if (signal?.quotaExceeded) return origins.map(() => null);

  const originStr = origins.map((o) => `${o.lat},${o.lon}`).join("|");
  const url = `${GOONG_API}?origins=${encodeURIComponent(originStr)}&destinations=${dest.lat},${dest.lon}&vehicle=bike&api_key=${apiKey}`;

  try {
    const res = await fetchRetrying(url);
    if (!res.ok) {
      // Still refusing after backoff: not a burst, so stop the rest of the batch
      // rather than hammering a capped key.
      if (res.status === 429 && signal) signal.quotaExceeded = true;
      return origins.map(() => null);
    }
    const data = await res.json();
    const rows: { elements?: { status: string; distance: { value: number }; duration: { value: number } }[] }[] =
      data.rows ?? [];
    if (rows.length !== origins.length) return origins.map(() => null);
    return origins.map((_, i) => {
      const el = rows[i]?.elements?.[0];
      if (!el || el.status !== "OK") return null;
      return {
        distance_km: Math.round(el.distance.value / 100) / 10,
        eta_mins: Math.round(el.duration.value / 60),
      };
    });
  } catch {
    return origins.map(() => null);
  }
}

/** 1→N batch road distance via Goong (motorbike). Returns null per destination if unavailable. */
export async function goongMatrix(
  originLat: number,
  originLon: number,
  destinations: { lat: number; lon: number }[],
  apiKey: string = process.env.GOONG_API_KEY ?? "",
  signal?: QuotaSignal
): Promise<(GoongResult | null)[]> {
  if (!apiKey || destinations.length === 0) return destinations.map(() => null);
  // Daily quota already known exhausted — skip the request (cache-only fallback).
  if (signal?.quotaExceeded) return destinations.map(() => null);

  const destStr = destinations.map((d) => `${d.lat},${d.lon}`).join("|");
  const url = `${GOONG_API}?origins=${originLat},${originLon}&destinations=${encodeURIComponent(destStr)}&vehicle=bike&api_key=${apiKey}`;

  try {
    const res = await fetchRetrying(url);
    if (!res.ok) {
      // Still refusing after backoff — treat as exhausted, not as a burst.
      if (res.status === 429 && signal) signal.quotaExceeded = true;
      // Logged because this used to fail in total silence: a refusal returned null
      // with no status anywhere, so ~13,000 unpriced legs looked like missing data
      // rather than a provider saying no.
      console.warn(`[goong] matrix HTTP ${res.status} for 1x${destinations.length}`);
      return destinations.map(() => null);
    }
    const data = await res.json();
    const elements: { status: string; distance: { value: number }; duration: { value: number } }[] =
      data.rows?.[0]?.elements ?? [];
    return destinations.map((_, i) => {
      const el = elements[i];
      if (!el || el.status !== "OK") return null;
      return {
        distance_km: Math.round(el.distance.value / 100) / 10,
        eta_mins: Math.round(el.duration.value / 60),
      };
    });
  } catch (e) {
    console.warn(`[goong] matrix failed: ${e instanceof Error ? e.message : e}`);
    return destinations.map(() => null);
  }
}


// ── Provider chain ──────────────────────────────────────────────────────────
//
// Goong, then a SECOND Goong account, then VietMap. Each link is asked only for
// what the previous one could not answer, so a healthy primary costs exactly what
// it always did and the rest are never called.
//
// Why three. A single provider is a single point of failure whose failure mode is
// silent and permanent: refusals are never cached, so an unanswered pair is
// re-asked on every future pass and never resolves. That put a third of two
// months' legs beyond reach. The second Goong key exists because these are DAILY
// caps, not burst limits — pacing and batching both proved powerless against them
// (20 seconds between days still returned nothing), and the only thing that adds
// headroom against a daily cap is a separate allowance.
//
// Each link carries its OWN quota signal. Sharing one would let any exhausted
// provider silence the rest, which defeats the entire arrangement; omitting them
// means an exhausted provider is re-asked for every remaining pair.

import { vietmapMatrixOneToMany, vietmapMatrixManyToOne } from "./vietmap";

/** Per-run exhaustion state for the fallback links. Created once per day by the
 *  archive so one 429 stops that provider for the run rather than per call. */
export interface FallbackState {
  goong2: QuotaSignal;
  vietmap: QuotaSignal;
}

export const newFallbackState = (): FallbackState => ({
  goong2: { quotaExceeded: false },
  vietmap: { quotaExceeded: false },
});

/** The second Goong account, or null when it is unset or identical to the primary
 *  — asking the same exhausted key twice buys nothing but latency. */
function secondGoongKey(primary?: string): string | null {
  const k = process.env.GOONG_API_KEY_DISTANCE;
  if (!k) return null;
  const first = primary ?? process.env.GOONG_API_KEY ?? "";
  return k === first ? null : k;
}

/** Ask `provider` for the cells still missing, and merge what comes back. */
async function fillGaps(
  current: (GoongResult | null)[],
  ask: (gapIdx: number[]) => Promise<(GoongResult | null)[]>,
  label: string,
): Promise<(GoongResult | null)[]> {
  const gapIdx = current.map((r, i) => (r === null ? i : -1)).filter((i) => i >= 0);
  if (gapIdx.length === 0) return current;
  const got = await ask(gapIdx);
  const out = [...current];
  gapIdx.forEach((i, k) => { if (got[k]) out[i] = got[k]; });
  const recovered = out.filter((r, i) => current[i] === null && r !== null).length;
  if (recovered > 0) console.info(`[distance] ${label} recovered ${recovered}/${gapIdx.length} pairs`);
  return out;
}

/** 1 origin → N destinations, through the whole chain. */
export async function roadMatrixOneToMany(
  originLat: number, originLon: number, destinations: { lat: number; lon: number }[],
  apiKey?: string, signal?: QuotaSignal, fallback?: FallbackState,
): Promise<(GoongResult | null)[]> {
  let out = await goongMatrix(originLat, originLon, destinations, apiKey, signal);

  const key2 = secondGoongKey(apiKey);
  if (key2 && !fallback?.goong2.quotaExceeded) {
    out = await fillGaps(out, (idx) =>
      goongMatrix(originLat, originLon, idx.map((i) => destinations[i]), key2, fallback?.goong2), "goong#2");
  }
  if (!fallback?.vietmap.quotaExceeded) {
    out = await fillGaps(out, (idx) =>
      vietmapMatrixOneToMany(originLat, originLon, idx.map((i) => destinations[i]), undefined, fallback?.vietmap), "vietmap");
  }
  return out;
}

/** N origins → 1 destination, through the whole chain. */
export async function roadMatrixManyToOne(
  origins: { lat: number; lon: number }[], dest: { lat: number; lon: number },
  apiKey?: string, signal?: QuotaSignal, fallback?: FallbackState,
): Promise<(GoongResult | null)[]> {
  let out = await goongMatrixMultiOrigin(origins, dest, apiKey, signal);

  const key2 = secondGoongKey(apiKey);
  if (key2 && !fallback?.goong2.quotaExceeded) {
    out = await fillGaps(out, (idx) =>
      goongMatrixMultiOrigin(idx.map((i) => origins[i]), dest, key2, fallback?.goong2), "goong#2");
  }
  if (!fallback?.vietmap.quotaExceeded) {
    out = await fillGaps(out, (idx) =>
      vietmapMatrixManyToOne(idx.map((i) => origins[i]), dest, undefined, fallback?.vietmap), "vietmap");
  }
  return out;
}
