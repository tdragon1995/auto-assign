/**
 * Shared primitives for smart-assign driver ranking.
 * Used by lib/assign.ts (production path) and app/api/smart-assign/route.ts (preview endpoint).
 */

export type RefLabel = "Arrived" | "En Route" | "Next Stop" | "First Stop" | "Start Location";

export interface RefStop {
  lat: number;
  lon: number;
  label: RefLabel;
  customerName: string | null;
}

/** How long (ms) a driver's GPS fix is considered fresh enough to use instead of First Stop. */
export const GPS_FRESH_MS = 15 * 60 * 1000;

interface RouteStop {
  stopStatusId: number;
  latitude: number;
  longitude: number;
  customerName?: string;
  activityCompletedTs?: string;
}

/**
 * Select the reference stop for a driver from their ordered timeline stops.
 * Priority: Arrived (3) → En Route (2) → Next pending after last completed → First pending
 * Returns null when no suitable stop is found (e.g. empty route or all completed).
 */
export function selectReferenceStop(stops: RouteStop[]): RefStop | null {
  const valid = stops.filter((s) => s.latitude && s.longitude);
  if (valid.length === 0) return null;

  const toLoc = (s: RouteStop, label: RefLabel): RefStop => ({
    lat: s.latitude,
    lon: s.longitude,
    label,
    customerName: s.customerName ?? null,
  });

  const arrived  = valid.find((s) => s.stopStatusId === 3);
  if (arrived) return toLoc(arrived, "Arrived");

  const enRoute  = valid.find((s) => s.stopStatusId === 2);
  if (enRoute) return toLoc(enRoute, "En Route");

  let lastCompletedIdx = -1;
  for (let i = valid.length - 1; i >= 0; i--) {
    if (valid[i].stopStatusId === 4) { lastCompletedIdx = i; break; }
  }

  if (lastCompletedIdx === -1) {
    if (valid.every((s) => s.stopStatusId === 1)) return toLoc(valid[0], "First Stop");
    return null;
  }

  const nextPending = valid.slice(lastCompletedIdx + 1).find((s) => s.stopStatusId === 1);
  if (nextPending) return toLoc(nextPending, "Next Stop");
  return null;
}

/** Stats derived from a driver's timeline stops. */
export interface DriverStopStats {
  total: number;
  active: number;
  done: number;
  lastCompletedTs: string | null;
}

export function computeStopStats(stops: RouteStop[]): DriverStopStats {
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
 * Tiebreaker comparator for ranked driver candidates.
 * Order: distance asc → lastCompletedTs asc (null = most idle) → jobsDone asc → name asc
 */
export function rankingComparator(
  a: { sortDist: number; lastCompletedTs: string | null; jobsDone: number; name: string },
  b: { sortDist: number; lastCompletedTs: string | null; jobsDone: number; name: string }
): number {
  if (a.sortDist !== b.sortDist) return a.sortDist - b.sortDist;
  const aTs = a.lastCompletedTs ?? "";
  const bTs = b.lastCompletedTs ?? "";
  if (aTs !== bTs) return aTs.localeCompare(bTs);
  if (a.jobsDone !== b.jobsDone) return a.jobsDone - b.jobsDone;
  return a.name.localeCompare(b.name);
}
