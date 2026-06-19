/**
 * Shared primitives for smart-assign driver ranking.
 * Used by lib/assign.ts (production path) and app/api/smart-assign/route.ts (preview endpoint).
 */

import type { TimelineStop } from "./types";

export type RefLabel =
  | "Arrived"
  | "En Route"
  | "Next Stop"
  | "First Stop"
  | "Available"
  | "Start Location";

export interface RefStop {
  lat: number;
  lon: number;
  label: RefLabel;
  customerName: string | null;
  /** Timestamp used in tiebreak — semantics depend on label (see selectReferenceStop). */
  tiebreakTs: string | null;
  /**
   * Secondary distance reference: the driver's last completed stop.
   * Only set for "Next Stop" — the driver finished their previous stop but has
   * not started the next leg (status 1, not 2), so they may still be physically
   * at the last completed location. Distance ranking takes the min over
   * {lat,lon} (next stop) and {altLat,altLon} (last completed stop).
   */
  altLat?: number | null;
  altLon?: number | null;
}

/**
 * Route-state priority. Higher = more likely to be assigned.
 * Applied between distance and the per-label tiebreak ts.
 */
export const ROUTE_STATE_PRIORITY: Record<RefLabel, number> = {
  "Start Location": 5,
  "Available":      4,
  "Arrived":        3,
  "En Route":       2,
  "First Stop":     1,
  "Next Stop":      1,
};

/**
 * Select the reference stop for a driver from their ordered timeline stops.
 * Priority: Arrived (3) → En Route (2) → Next pending after last completed → First pending → Available (last stop)
 * Stops with non-empty deliveryWindows are skipped as candidates and fall through to the next-best stop.
 * Returns null when no usable stop exists.
 *
 * tiebreakTs semantics by label:
 *  - Arrived       → that stop's activityArrivedTs
 *  - En Route      → that stop's activityStartedTs
 *  - Next Stop     → max activityCompletedTs across completed stops
 *  - Available     → max activityCompletedTs across completed stops
 *  - First Stop    → driverShiftStartTs (caller supplies)
 *  - Start Location is assigned by the caller (no route today), not by this function.
 */
export function selectReferenceStop(
  stops: TimelineStop[],
  driverShiftStartTs?: string | null
): RefStop | null {
  const valid = stops.filter((s) => s.latitude && s.longitude);
  if (valid.length === 0) return null;

  const toRef = (s: TimelineStop, label: RefLabel, tiebreakTs: string | null): RefStop => ({
    lat: s.latitude,
    lon: s.longitude,
    label,
    customerName: s.customerName ?? null,
    tiebreakTs,
  });

  const arrived = valid.find((s) => s.stopStatusId === 3);
  if (arrived) return toRef(arrived, "Arrived", arrived.activityArrivedTs ?? null);

  const enRoute = valid.find((s) => s.stopStatusId === 2);
  if (enRoute) return toRef(enRoute, "En Route", enRoute.activityStartedTs ?? null);

  let lastCompletedIdx = -1;
  let maxCompletedTs: string | null = null;
  let lastDoneByTime: TimelineStop | null = null;
  for (let i = 0; i < valid.length; i++) {
    if (valid[i].stopStatusId !== 4) continue;
    lastCompletedIdx = i;
    const ts = valid[i].activityCompletedTs;
    if (ts && (!maxCompletedTs || ts > maxCompletedTs)) {
      maxCompletedTs = ts;
      lastDoneByTime = valid[i];
    }
  }

  if (lastCompletedIdx === -1) {
    if (valid.every((s) => s.stopStatusId === 1)) {
      return toRef(valid[0], "First Stop", driverShiftStartTs ?? null);
    }
    return null;
  }

  const nextPending = valid.slice(lastCompletedIdx + 1).find((s) => s.stopStatusId === 1);
  if (nextPending) {
    // Driver hasn't started this leg yet → may still be at the last completed
    // stop. Attach it as a secondary distance reference (min of both is used).
    const lastDone = lastDoneByTime ?? valid[lastCompletedIdx];
    return {
      ...toRef(nextPending, "Next Stop", maxCompletedTs),
      altLat: lastDone.latitude ?? null,
      altLon: lastDone.longitude ?? null,
    };
  }

  return toRef(valid[valid.length - 1], "Available", maxCompletedTs);
}

/** Stats derived from a driver's timeline stops. */
export interface DriverStopStats {
  total: number;
  active: number;
  done: number;
  lastCompletedTs: string | null;
}

export function computeStopStats(stops: TimelineStop[]): DriverStopStats {
  let active = 0;
  let lastCompletedTs: string | null = null;
  for (const s of stops) {
    if (s.stopStatusId !== 4) { active++; continue; }
    if (s.activityCompletedTs && (!lastCompletedTs || s.activityCompletedTs > lastCompletedTs)) {
      lastCompletedTs = s.activityCompletedTs;
    }
  }
  return { total: stops.length, active, done: stops.length - active, lastCompletedTs };
}

/**
 * Band width (km) for the En-Route GPS tiebreak. Two en-route drivers whose
 * live-GPS haversine to the pickup falls in different `floor(gpsKm / BAND)`
 * bins are split by GPS; within the same bin we defer to the started-earliest
 * (FIFO) tiebreak so ping jitter (~0.1 km) doesn't override fairness.
 */
export const GPS_TIEBREAK_BAND_KM = 1.2;

/**
 * En-Route-only GPS tiebreak, returned as a comparator delta (0 = defer to the
 * next key). When two drivers are both en route to (effectively) the pickup,
 * the road distance from their reference stop is ~0 for both and discards who
 * is physically closer to arriving; live-GPS haversine recovers that signal.
 *
 * Banded (not a raw `> BAND` deadband) on purpose: a raw deadband is
 * non-transitive and corrupts Array.sort once 3+ candidates straddle the
 * threshold. Comparing `floor(gpsKm / BAND)` bins is a total order, hence
 * transitive. Callers MUST apply this only AFTER the route-state-priority
 * check has found equal priority: "En Route" uniquely owns priority 2, so an
 * equal-priority group is homogeneously En Route and the banded order stays
 * transitive within it. (If another label is ever given priority 2, revisit.)
 */
export function enRouteGpsBand(
  a: { label: RefLabel | null; gpsKm: number },
  b: { label: RefLabel | null; gpsKm: number }
): number {
  if (a.label !== "En Route" || b.label !== "En Route") return 0;
  return Math.floor(a.gpsKm / GPS_TIEBREAK_BAND_KM) - Math.floor(b.gpsKm / GPS_TIEBREAK_BAND_KM);
}

/**
 * Tiebreaker comparator for ranked driver candidates.
 * Order: sortDist asc → routeStatePriority desc → en-route GPS band asc
 *      → tiebreakTs asc (null = highest priority) → jobsDone asc → name asc
 */
export function rankingComparator(
  a: { sortDist: number; priority: number; label: RefLabel | null; gpsKm: number; tiebreakTs: string | null; jobsDone: number; name: string },
  b: { sortDist: number; priority: number; label: RefLabel | null; gpsKm: number; tiebreakTs: string | null; jobsDone: number; name: string }
): number {
  if (a.sortDist !== b.sortDist) return a.sortDist - b.sortDist;
  if (a.priority !== b.priority) return b.priority - a.priority;
  const band = enRouteGpsBand(a, b);
  if (band !== 0) return band;
  const aTs = a.tiebreakTs ?? "";
  const bTs = b.tiebreakTs ?? "";
  if (aTs !== bTs) return aTs.localeCompare(bTs);
  if (a.jobsDone !== b.jobsDone) return a.jobsDone - b.jobsDone;
  return a.name.localeCompare(b.name);
}
