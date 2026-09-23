import { getCustomerById, type Env } from "./cartrack";
import { haversineKm } from "./distance";

/**
 * One-tap chấm công: a check-in/out made standing at the branch is completed on the
 * spot, instead of leaving the driver to finish the task again in the Cartrack app.
 *
 * "Standing at the branch" is the phone's own GPS reading, checked HERE on the server
 * against the branch's Cartrack customer coordinates. Anything short of a clear yes —
 * too far, a reading too vague to judge, no reading at all, a branch with no
 * coordinates — leaves the job open exactly as before, so the driver can still finish
 * it in the app. The geofence only ever removes a step; it never refuses a check-in.
 *
 * Straight-line distance, deliberately: a 200 m radius needs no road router, and the
 * road providers are the billed, daily-capped ones (CLAUDE.md footgun 12).
 */

/** How close counts as "at the branch". */
export const CHAM_CONG_RADIUS_M = 200;

/** A reading vaguer than this cannot tell "at the door" from "down the street".
 *  Indoor phone GPS is routinely 50–300 m off; those taps fall back to the app. */
export const CHAM_CONG_MAX_ACCURACY_M = 100;

export type PresenceVerdict = "near" | "far" | "inaccurate" | "no_position" | "no_branch";

export interface Presence {
  verdict: PresenceVerdict;
  /** Metres from the branch, rounded. Absent when there was nothing to measure. */
  distance_m?: number;
  /** The reading's own accuracy radius in metres, rounded, as the browser reported it. */
  accuracy_m?: number;
}

export interface LatLng {
  lat: number;
  lon: number;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The browser position from a request body, or null when it is missing or malformed.
 *  (0, 0) is refused: it is what a failed fix serialises to, not a place in Vietnam. */
export function parsePosition(raw: unknown): { lat: number; lon: number; accuracy: number | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const lat = r.lat;
  const lon = r.lng ?? r.lon;
  if (!finite(lat) || !finite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  const accuracy = finite(r.accuracy) && r.accuracy >= 0 ? r.accuracy : null;
  return { lat, lon, accuracy };
}

/** Is this reading at the branch? Pure — every input is passed in. A reading with no
 *  accuracy figure is treated as unjudgeable rather than as exact. */
export function checkPresence(rawPosition: unknown, branch: LatLng | null): Presence {
  const pos = parsePosition(rawPosition);
  if (!pos) return { verdict: "no_position" };
  const accuracy_m = pos.accuracy == null ? undefined : Math.round(pos.accuracy);
  if (!branch) return { verdict: "no_branch", accuracy_m };

  const distance_m = Math.round(haversineKm(pos.lat, pos.lon, branch.lat, branch.lon) * 1000);
  if (pos.accuracy == null || pos.accuracy > CHAM_CONG_MAX_ACCURACY_M) {
    return { verdict: "inaccurate", distance_m, accuracy_m };
  }
  return { verdict: distance_m <= CHAM_CONG_RADIUS_M ? "near" : "far", distance_m, accuracy_m };
}

// Branches do not move, so one lookup per branch per instance per day is plenty. A
// failed lookup is not cached: the next tap simply asks again.
const BRANCH_TTL_MS = 24 * 60 * 60 * 1000;
const branchCache = new Map<string, { coords: LatLng; at: number }>();

/** The branch's coordinates from its Cartrack customer record — the same point the
 *  Cartrack app itself routes drivers to. Null on any failure. */
export async function branchCoords(customerId: string, env: Env): Promise<LatLng | null> {
  const key = `${env}:${customerId}`;
  const hit = branchCache.get(key);
  if (hit && Date.now() - hit.at < BRANCH_TTL_MS) return hit.coords;
  try {
    const res = await getCustomerById(customerId, env);
    const lat = Number(res?.data?.latitude);
    const lon = Number(res?.data?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
    const coords = { lat, lon };
    branchCache.set(key, { coords, at: Date.now() });
    return coords;
  } catch {
    return null;
  }
}
