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


// ── Provider fallback ───────────────────────────────────────────────────────
//
// Goong first, VietMap for whatever it could not answer. Two providers because
// one is a single point of failure for every distance in the system, and its
// failure mode is silent AND permanent: unanswered pairs are never cached, so
// they are re-asked forever and never resolve. That left a third of two months'
// legs with no distance, no target and no verdict.
//
// Only the null cells are retried, so a healthy Goong costs exactly what it
// always did and VietMap is never called at all.

import { vietmapMatrixOneToMany, vietmapMatrixManyToOne } from "./vietmap";

/** True when a result set has gaps worth asking a second provider about. */
const hasGaps = (rs: (GoongResult | null)[]) => rs.some((r) => r === null);

/** 1 origin → N destinations, with VietMap covering Goong's misses. */
export async function roadMatrixOneToMany(
  originLat: number, originLon: number, destinations: { lat: number; lon: number }[],
  apiKey?: string, signal?: QuotaSignal,
  /** SEPARATE signal for the fallback. Sharing one would let either provider's
   *  exhaustion silence the other, which defeats the point of having two — but
   *  giving the fallback none at all meant a rate-limited VietMap kept being
   *  hammered for every remaining pair. It needs its own. */
  fallbackSignal?: QuotaSignal,
): Promise<(GoongResult | null)[]> {
  const primary = await goongMatrix(originLat, originLon, destinations, apiKey, signal);
  if (!hasGaps(primary)) return primary;
  if (fallbackSignal?.quotaExceeded) return primary;

  // Ask only for the gaps — a partial answer from Goong is still cheaper than a
  // full second request, and keeps the two providers' coverage disjoint.
  const gapIdx = primary.map((r, i) => (r === null ? i : -1)).filter((i) => i >= 0);
  const backup = await vietmapMatrixOneToMany(
    originLat, originLon, gapIdx.map((i) => ({ lat: destinations[i].lat, lon: destinations[i].lon })),
    undefined, fallbackSignal,
  );
  const filled = [...primary];
  gapIdx.forEach((i, k) => { if (backup[k]) filled[i] = backup[k]; });
  const recovered = filled.filter((r, i) => primary[i] === null && r !== null).length;
  if (recovered > 0) console.info(`[distance] vietmap recovered ${recovered}/${gapIdx.length} pairs goong could not answer`);
  return filled;
}

/** N origins → 1 destination, with VietMap covering Goong's misses. */
export async function roadMatrixManyToOne(
  origins: { lat: number; lon: number }[], dest: { lat: number; lon: number },
  apiKey?: string, signal?: QuotaSignal, fallbackSignal?: QuotaSignal,
): Promise<(GoongResult | null)[]> {
  const primary = await goongMatrixMultiOrigin(origins, dest, apiKey, signal);
  if (!hasGaps(primary)) return primary;
  if (fallbackSignal?.quotaExceeded) return primary;

  const gapIdx = primary.map((r, i) => (r === null ? i : -1)).filter((i) => i >= 0);
  const backup = await vietmapMatrixManyToOne(
    gapIdx.map((i) => ({ lat: origins[i].lat, lon: origins[i].lon })), { lat: dest.lat, lon: dest.lon },
    undefined, fallbackSignal,
  );
  const filled = [...primary];
  gapIdx.forEach((i, k) => { if (backup[k]) filled[i] = backup[k]; });
  const recovered = filled.filter((r, i) => primary[i] === null && r !== null).length;
  if (recovered > 0) console.info(`[distance] vietmap recovered ${recovered}/${gapIdx.length} pairs goong could not answer`);
  return filled;
}
