/**
 * VietMap Matrix v4 — the fallback road-distance provider behind Goong.
 *
 * WHY A SECOND PROVIDER. Goong is a single point of failure for every distance in
 * the system, and when it stops answering the failure is silent and permanent:
 * failed lookups are deliberately never cached, so an unanswered pair is re-asked
 * on every future pass and never resolves. That is exactly what left ~13,000 legs
 * (a third of two months' work) with no distance, no target and no verdict — and
 * because nothing logged a status code, it took three wrong explanations to find.
 *
 * SHAPE MATCHES GOONG DELIBERATELY. Same GoongResult out, same "null means no
 * answer" contract, so the cache, the batching and every caller stay unchanged and
 * neither provider is privileged anywhere except the one fallback line.
 *
 * DOCS: https://maps.vietmap.vn/docs/map-api/matrix-version/matrix-v4/
 *   GET /api/matrix/v4?apikey=…&point=lat,lng&point=…&sources=0;1&destinations=2;3
 *   → { code, messages, durations: [[seconds]], distances: [[metres]] }
 * Rows are sources, columns are destinations. `annotation` is left unset: the
 * documented example returns BOTH arrays under the default, and the enum offers no
 * way to ask for both explicitly.
 *
 * Distances from two providers will not agree to the metre. That is acceptable and
 * visible — a leg priced by either is far better than one with no price at all —
 * but it is why the fallback is a fallback and not a load-balanced pair.
 */
import type { GoongResult, QuotaSignal } from "./distance";

const VIETMAP_MATRIX = "https://maps.vietmap.vn/api/matrix/v4";

/** Goong is asked for `bike`; VietMap v4's equivalent profile is `motorcycle`
 *  (its enum is car / motorcycle / truck / container — there is no bike). */
const VEHICLE = "motorcycle";

export interface Pt { lat: number; lon: number }

/** Codes that mean "do not bother asking again this run". Distinguished from a
 *  routing miss so a caller can stop hammering a provider that has cut us off. */
const HARD_STOP_CODES = new Set(["OVER_DAILY_LIMIT", "OVER_QUERY_LIMIT", "REQUEST_DENIED", "INVALID_API_KEY"]);

/**
 * Full origins × destinations matrix. Returns `result[i][j]`, or null in any cell
 * the provider could not answer.
 *
 * Never throws: a fallback that can take down the caller is worse than no fallback.
 */
export async function vietmapMatrix(
  origins: Pt[],
  destinations: Pt[],
  apiKey: string = process.env.VIETMAP_API_KEY ?? "",
  signal?: QuotaSignal,
): Promise<(GoongResult | null)[][]> {
  const empty = () => origins.map(() => destinations.map(() => null));
  if (!apiKey || origins.length === 0 || destinations.length === 0) return empty();
  if (signal?.quotaExceeded) return empty();

  // Points are one flat list; sources and destinations are index ranges into it.
  const points = [...origins, ...destinations]
    .map((p) => `point=${p.lat},${p.lon}`)
    .join("&");
  const srcIdx = origins.map((_, i) => i).join(";");
  const dstIdx = destinations.map((_, i) => origins.length + i).join(";");
  const url = `${VIETMAP_MATRIX}?apikey=${encodeURIComponent(apiKey)}&${points}` +
              `&vehicle=${VEHICLE}&sources=${srcIdx}&destinations=${dstIdx}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[vietmap] matrix HTTP ${res.status} for ${origins.length}x${destinations.length}`);
      if (res.status === 429 && signal) signal.quotaExceeded = true;
      return empty();
    }
    const data = await res.json();
    if (data?.code && data.code !== "OK") {
      console.warn(`[vietmap] matrix code=${data.code} ${data.messages ?? ""}`);
      if (HARD_STOP_CODES.has(data.code) && signal) signal.quotaExceeded = true;
      return empty();
    }

    const dist: unknown = data?.distances;
    const dur: unknown = data?.durations;
    const num = (row: unknown, j: number): number | null => {
      const v = Array.isArray(row) ? row[j] : undefined;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };

    return origins.map((_, i) => destinations.map((__, j) => {
      const metres = num(Array.isArray(dist) ? dist[i] : undefined, j);
      const seconds = num(Array.isArray(dur) ? dur[i] : undefined, j);
      // Distance is the load-bearing value — a duration with no distance cannot
      // price a leg, so that cell counts as unanswered.
      if (metres == null) return null;
      return {
        // Same rounding as the Goong path (one decimal km), so a pair priced by
        // either provider lands on the same cache key shape and reads alike.
        distance_km: Math.round(metres / 100) / 10,
        eta_mins: seconds == null ? 0 : Math.round(seconds / 60),
      };
    }));
  } catch (e) {
    console.warn(`[vietmap] matrix failed: ${e instanceof Error ? e.message : e}`);
    return empty();
  }
}

/** 1 origin → N destinations, matching goongMatrix's signature and return shape. */
export async function vietmapMatrixOneToMany(
  originLat: number, originLon: number, destinations: Pt[],
  apiKey?: string, signal?: QuotaSignal,
): Promise<(GoongResult | null)[]> {
  const m = await vietmapMatrix([{ lat: originLat, lon: originLon }], destinations, apiKey, signal);
  return m[0] ?? destinations.map(() => null);
}

/** N origins → 1 destination, matching goongMatrixMultiOrigin. */
export async function vietmapMatrixManyToOne(
  origins: Pt[], dest: Pt, apiKey?: string, signal?: QuotaSignal,
): Promise<(GoongResult | null)[]> {
  const m = await vietmapMatrix(origins, [dest], apiKey, signal);
  return origins.map((_, i) => m[i]?.[0] ?? null);
}
