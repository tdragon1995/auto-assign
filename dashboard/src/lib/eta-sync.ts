/**
 * Publishes a pickup ETA back to Labcenter for delivery requests that are already
 * assigned to a Cartrack driver but not yet collected.
 *
 * WHY THIS EXISTS — Labcenter shows its dispatchers a request sitting in "assigned"
 * with no indication of when the driver will actually turn up. Cartrack knows: the
 * driver has an ordered route, and the pickup sits somewhere down it. This walks that
 * route and writes the answer back as `expected_assign_minute` (minutes from now).
 *
 * THE JOIN — a Labcenter request carries `delivery_integration_request_id`, which is
 * the Cartrack `job_id` as a string. That is the only link between the two systems;
 * rows from any other integration are skipped rather than guessed at.
 *
 * WHAT "the driver is here" MEANS — deliberately NOT live GPS. Every leg is measured
 * between fixed stop coordinates, so each one is a stable pair that the road-distance
 * cache can hold and re-serve on later cycles. Live GPS would be a fresh,
 * never-repeated coordinate on every run: it would bill Goong every cycle and write
 * cache keys that can never be hit again. The driver's position is therefore taken as
 * the last stop they have arrived at or completed — accurate to one leg, and free
 * after the first cycle.
 *
 * The estimate is travel time along the remaining legs plus a flat service allowance
 * per stop still to be worked before the pickup.
 */

import { getTimelineRoutes, type Env } from "./cartrack";
import type { TimelineRoute, TimelineStop } from "./types";
import { roadDistancesForPairs } from "./distance-cache";
import { haversineKm } from "./distance";
import {
  getAdminToken,
  listDeliveryRequests,
  updateExpectedAssign,
  type DeliveryRequest,
} from "./labcenter";
import { vnDate } from "./time";

/** Flat allowance for working one stop (park, hand over, paperwork, remount). */
export const STOP_SERVICE_MINS = 5;

/** Only rows Cartrack owns can be traced to a route. */
const CARTRACK_CODE = "cartrack_vn";

/** Cartrack stop_status_id values that mean the stop needs no more of the driver's time. */
const STOP_DONE = new Set([4, 5]); // 4 = Hoàn thành, 5 = Từ chối

/** Fallback speed when Goong has nothing for a leg (quota, outage, unroutable pair).
 *  Deliberately slow — a late ETA is a better failure than a confidently early one
 *  that has a dispatcher promising a branch a driver who is not coming. */
const FALLBACK_KMH = 18;

/** Labcenter refuses anything outside this range, and it is not in any doc — the
 *  bounds come from the API's own rejection:
 *    "the_expected_assign_minute_field_must_be_between10_and480"
 *  An 8-minute estimate is a legitimate answer that simply cannot be expressed, so
 *  values are clamped rather than dropped; `clamped` records that on the outcome so a
 *  reported "10 min" is never mistaken for a measurement. */
const MIN_ASSIGN_MINUTES = 10;
const MAX_ASSIGN_MINUTES = 480;

export interface EtaOutcome {
  request_id: number;
  code: string;
  job_id: number | null;
  /** Set when no ETA could be produced; the row is then left untouched. */
  skipped?: string;
  driver_id?: string;
  /** What was published — already clamped to Labcenter's accepted range. */
  minutes?: number;
  /** The raw estimate, present only when clamping changed it. */
  clamped?: number;
  /** Legs walked and stops charged service time — shown so a wrong ETA is diagnosable. */
  legs?: number;
  stops_ahead?: number;
  /** True when travel came from the haversine fallback rather than road distances. */
  degraded?: boolean;
  patched?: boolean;
  error?: string;
}

export interface EtaSyncResult {
  scanned: number;
  patched: number;
  skipped: number;
  failed: number;
  outcomes: EtaOutcome[];
}

/** The VN business day as the UTC instants Labcenter's created_at filter expects. */
export function vnDayUtcWindow(date: string = vnDate()): { from: string; to: string } {
  const [y, m, d] = date.split("-").map(Number);
  const startUtc = Date.UTC(y, m - 1, d, 0, 0, 0) - 7 * 3600 * 1000;
  const endUtc = Date.UTC(y, m - 1, d, 23, 59, 59) - 7 * 3600 * 1000;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "+00:00";
  return { from: iso(startUtc), to: iso(endUtc) };
}

type Located = TimelineStop & { latitude: number; longitude: number };

function hasCoords(s: TimelineStop): s is Located {
  return typeof s.latitude === "number" && typeof s.longitude === "number"
    && Number.isFinite(s.latitude) && Number.isFinite(s.longitude);
}

function isDone(s: TimelineStop): boolean {
  return Boolean(s.activityCompletedTs) || STOP_DONE.has(s.stopStatusId);
}

/** The driver has been at a stop once they have arrived, even if not yet finished. */
function isReached(s: TimelineStop): boolean {
  return Boolean(s.activityArrivedTs) || isDone(s);
}

/** Where a job's pickup sits on a driver's ordered route.
 *
 *  Prefers stop_type_id 1 (pickup). A job whose only stop for this driver is a
 *  dropoff/delivery still gets its first stop used, because the question Labcenter is
 *  asking — when does the driver reach this request — is answered by whichever stop
 *  of it the driver hits first. */
function findTarget(routes: TimelineRoute[], jobId: number):
  { route: TimelineRoute; stops: TimelineStop[]; index: number } | null {
  for (const route of routes) {
    const stops = route.orderedStops ?? [];
    let pickup = -1;
    let anyStop = -1;
    for (let i = 0; i < stops.length; i++) {
      if (stops[i]?.jobId !== jobId) continue;
      if (anyStop < 0) anyStop = i;
      if (stops[i].stopTypeId === 1) { pickup = i; break; }
    }
    const index = pickup >= 0 ? pickup : anyStop;
    if (index >= 0) return { route, stops, index };
  }
  return null;
}

/** Consecutive legs from the driver's current position up to (and including) the
 *  arrival at `index`, plus how many stops still need working before it.
 *
 *  Returns a reason string instead of a plan when no honest estimate exists. */
function planToTarget(stops: TimelineStop[], index: number):
  { legs: { from: Located; to: Located }[]; stopsAhead: number } | { skip: string } {
  // Nothing to promise about a pickup the driver is already standing at or has done.
  if (isReached(stops[index])) return { skip: "driver already at the pickup" };

  // Last stop the driver has actually been to — their position, as a fixed point.
  let origin = -1;
  for (let i = index - 1; i >= 0; i--) {
    if (isReached(stops[i])) { origin = i; break; }
  }

  // Run not started AND the pickup is the first stop: there is no fixed point behind
  // the driver to measure from, and without live GPS their position is genuinely
  // unknown. Reporting the 0 that falls out of an empty leg list would tell the
  // dispatcher the driver is at the door. Say nothing instead.
  if (origin < 0 && index === 0) return { skip: "driver has not started the route" };

  // Not started but the pickup is further down: measure from the route's own first
  // stop. This understates by the driver's approach to that stop — flagged upstream.
  const start = origin >= 0 ? origin : 0;

  const legs: { from: Located; to: Located }[] = [];
  let prev: Located | null = hasCoords(stops[start]) ? stops[start] : null;
  let stopsAhead = 0;
  // Every stop from the driver's position up to (not including) the pickup still has
  // to be worked. The origin counts too when they are standing at it unfinished; it
  // drops out on its own once completed.
  for (let i = start; i < index; i++) {
    if (!isDone(stops[i])) stopsAhead++;
  }
  for (let i = start + 1; i <= index; i++) {
    const s = stops[i];
    if (!hasCoords(s)) continue;              // unmappable stop: skip the leg, keep the chain
    if (prev) legs.push({ from: prev, to: s });
    prev = s;
  }

  return { legs, stopsAhead };
}

/**
 * One sync pass: read today's late-assigned requests, price each one's remaining
 * route, and PATCH the answer back.
 *
 * `dryRun` computes and reports without writing — used to eyeball the numbers against
 * live routes before letting it near production rows.
 */
export async function runEtaSync(opts: {
  env?: Env;
  date?: string;
  lateOverStatus?: string;
  lateOverMin?: number;
  dryRun?: boolean;
  /** Restrict the pass to one delivery_request id — for re-syncing or verifying a
   *  single row without touching the rest of the queue. */
  only?: number;
} = {}): Promise<EtaSyncResult> {
  const env = opts.env ?? "prod";
  const date = opts.date ?? vnDate();
  const outcomes: EtaOutcome[] = [];

  const token = await getAdminToken();
  if (!token) throw new Error("Labcenter admin login failed (LABCENTER_EMAIL / LABCENTER_PASSWORD)");

  const window = vnDayUtcWindow(date);
  const all = await listDeliveryRequests({
    fromCreatedAt: window.from,
    toCreatedAt: window.to,
    lateOverStatus: opts.lateOverStatus ?? "assigned",
    lateOverMin: opts.lateOverMin ?? 30,
  }, token);
  const requests = opts.only ? all.filter((r) => r.id === opts.only) : all;

  if (requests.length === 0) {
    return { scanned: 0, patched: 0, skipped: 0, failed: 0, outcomes };
  }

  const routes = await getTimelineRoutes(date, env);
  if (!routes) throw new Error("Cartrack timeline unavailable (CARTRACK_WEB_PASS / fleetweb login)");

  // Resolve every leg of every request in ONE cache+Goong pass. Legs repeat heavily
  // across requests riding the same driver's route, and resolvePairs dedupes them.
  type Planned = {
    req: DeliveryRequest;
    jobId: number;
    driverId: string;
    legs: { from: Located; to: Located }[];
    stopsAhead: number;
  };
  const planned: Planned[] = [];

  for (const req of requests) {
    const base: EtaOutcome = { request_id: req.id, code: req.code, job_id: null };

    if (req.delivery_integration_code !== CARTRACK_CODE) {
      outcomes.push({ ...base, skipped: `not a Cartrack request (${req.delivery_integration_code ?? "none"})` });
      continue;
    }
    const jobId = Number(req.delivery_integration_request_id);
    if (!Number.isFinite(jobId) || jobId <= 0) {
      outcomes.push({ ...base, skipped: "no Cartrack job id on the request" });
      continue;
    }
    base.job_id = jobId;

    if (req.pickup_completed_at) {
      outcomes.push({ ...base, skipped: "pickup already collected" });
      continue;
    }

    // WRITE-ONCE. update-expected-assign accepts a value only while expected_assign_at
    // is null; a second call returns HTTP 500 "System error" whatever the value, even
    // from the account that set it (verified on prod 2026-08-11 — patched a row, then
    // re-patched it twice, 500 both times). So a row that already carries an ETA — set
    // by us on an earlier cycle, or by a dispatcher in the Labcenter UI — is left
    // alone. Without this guard every cycle after the first would be all 500s.
    //
    // The consequence worth knowing: an ETA cannot be revised as the driver moves.
    // That is why the estimator would rather skip than publish a number it cannot
    // stand behind — the row stays eligible for a later cycle, and there is no second
    // chance once something is written.
    if (req.expected_assign_at) {
      outcomes.push({ ...base, skipped: "ETA already published (write-once)" });
      continue;
    }

    const found = findTarget(routes, jobId);
    if (!found) {
      outcomes.push({ ...base, skipped: "job is on no driver's route yet" });
      continue;
    }
    const driverId = found.route.routeId?.replace(/^driver_/, "") ?? "";
    const plan = planToTarget(found.stops, found.index);
    if ("skip" in plan) {
      outcomes.push({ ...base, driver_id: driverId, skipped: plan.skip });
      continue;
    }
    planned.push({ req, jobId, driverId, legs: plan.legs, stopsAhead: plan.stopsAhead });
  }

  const allLegs = planned.flatMap((p) => p.legs)
    .map((l) => ({ from: { lat: l.from.latitude, lon: l.from.longitude },
                   to:   { lat: l.to.latitude,   lon: l.to.longitude } }));
  const resolved = allLegs.length
    ? await roadDistancesForPairs(allLegs, process.env.GOONG_API_KEY_DISTANCE || process.env.GOONG_API_KEY)
    : [];

  let cursor = 0;
  for (const p of planned) {
    const base: EtaOutcome = {
      request_id: p.req.id, code: p.req.code, job_id: p.jobId,
      driver_id: p.driverId, legs: p.legs.length, stops_ahead: p.stopsAhead,
    };

    let travel = 0;
    let degraded = false;
    for (const leg of p.legs) {
      const r = resolved[cursor++];
      if (r && typeof r.eta_mins === "number") {
        travel += r.eta_mins;
      } else {
        // Straight-line at a conservative city speed rather than dropping the leg —
        // omitting it would silently understate the ETA.
        const km = haversineKm(leg.from.latitude, leg.from.longitude, leg.to.latitude, leg.to.longitude);
        travel += (km / FALLBACK_KMH) * 60;
        degraded = true;
      }
    }

    const estimate = Math.max(0, Math.round(travel + p.stopsAhead * STOP_SERVICE_MINS));
    const minutes = Math.min(MAX_ASSIGN_MINUTES, Math.max(MIN_ASSIGN_MINUTES, estimate));
    base.minutes = minutes;
    if (minutes !== estimate) base.clamped = estimate;
    if (degraded) base.degraded = true;

    if (opts.dryRun) {
      outcomes.push({ ...base, patched: false });
      continue;
    }
    const res = await updateExpectedAssign(p.req.id, minutes, token);
    outcomes.push(res.ok ? { ...base, patched: true } : { ...base, patched: false, error: res.error });
  }

  return {
    scanned: requests.length,
    patched: outcomes.filter((o) => o.patched).length,
    skipped: outcomes.filter((o) => o.skipped).length,
    failed: outcomes.filter((o) => o.error).length,
    outcomes,
  };
}
