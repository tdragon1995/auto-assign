/**
 * Driver TAT (turnaround time): turning a day of Cartrack routes into the legs a
 * driver actually rode, priced against the distance each one covered.
 *
 * THE UNIT IS A LEG, NOT A JOB.
 *   A job's pickup and dropoff are not generally a ride. A driver collecting at
 *   three clinics before running to the lab drives A→B, B→C, C→lab; the
 *   job-shaped view would instead see three "trips" that each begin at a place
 *   the driver had already left, and would charge them for distance they never
 *   covered on that leg. So the day is cut into consecutive stop pairs.
 *
 * THE ORDER IS THE ONE THAT HAPPENED.
 *   Legs are cut from stops sorted by completion time, not from the planned
 *   `orderedStops` sequence. A driver who re-sequences their run — which is
 *   normal — would otherwise be measured against pairs they never rode.
 *
 * THE CLOCK — completion at this stop → arrival at the next.
 *   Time on the road. Loading, queueing and paperwork at either end sit outside
 *   it, because they are neither the driver's choice nor their pace.
 *
 * THE TARGET — max(1, ceil(km)) * 4 minutes, i.e. an effective 15 km/h.
 *   Sounds slow read as a speed; it is not, once HCMC traffic, lights, parking
 *   and the walk into a clinic are inside the same number. The ceil is on whole
 *   kilometres so a driver can check the target in their head: 7 km → 28 minutes.
 */
import { roadDistancesForPairs } from "./distance-cache";
import { isChamCong } from "./job-filters";
import type { TimelineRoute, TimelineStop } from "./types";

/** Minutes allowed per whole kilometre. The single number a supervisor is most
 *  likely to want to tune — everything else derives from it. */
export const MINS_PER_KM = 4;

/**
 * How far past its target a leg may run before it stops counting as a slow ride
 * and starts counting as a wait.
 *
 * Without this, one lunch break lands as "trễ 130 phút" and every driver learns
 * on day one that the report does not describe their work — which costs more
 * than the metric is worth. Legs over the line are still stored and still shown,
 * labelled as a wait, but they are left ungraded rather than counted as failures.
 */
export const LONG_GAP_OVER_TARGET_MINS = 45;

/** One archived leg. Field names match the tat_legs columns exactly so a row can
 *  go straight to PostgREST without a mapping layer in between. */
export interface TatLeg {
  trip_date: string;
  driver_id: string;
  driver_name: string | null;
  seq: number;

  from_stop_id: number | null;
  from_job_id: number | null;
  from_customer_id: string | null;
  from_name: string | null;
  from_lat: number | null;
  from_lng: number | null;
  departed_ts: string | null;

  to_stop_id: number | null;
  to_job_id: number | null;
  to_customer_id: string | null;
  to_name: string | null;
  to_lat: number | null;
  to_lng: number | null;
  arrived_ts: string | null;

  tat_mins: number | null;
  tat_basis: "arrived" | "completed" | null;
  distance_km: number | null;
  target_mins: number | null;
  /** Goong's own travel-time estimate for this leg. REFERENCE ONLY — it never
   *  grades anything. Kept beside target_mins so a late leg can be read as either
   *  "the driver was slow" or "this route is slow", which a flat per-km rule
   *  cannot distinguish on its own. Comes free: Goong returns duration in the same
   *  response as distance, and the cache has stored both all along. */
  eta_mins: number | null;
  on_time: boolean | null;
  long_gap: boolean;
}

/** Cartrack hands back VN-local wall time with no zone ("2026-08-12 14:31:07").
 *  Postgres timestamptz would read that as UTC and shift every leg seven hours,
 *  so the offset is attached explicitly rather than left to be inferred. */
function toIso(ts: string | null | undefined): string | null {
  if (!ts || typeof ts !== "string" || ts.length < 19) return null;
  return `${ts.slice(0, 10)}T${ts.slice(11, 19)}+07:00`;
}

function minutesBetween(fromIso: string | null, toIsoTs: string | null): number | null {
  if (!fromIso || !toIsoTs) return null;
  const ms = Date.parse(toIsoTs) - Date.parse(fromIso);
  if (!Number.isFinite(ms)) return null;
  // Negative means the stamps are out of order — a driver catching up on taps
  // after the fact. Not a measurement, so it is dropped rather than clamped.
  if (ms < 0) return null;
  return Math.round(ms / 60_000);
}

/** Minutes a leg of this length is allowed. Null distance → no target, and the
 *  leg is reported but left ungraded rather than being guessed at. */
export function targetMinsFor(distanceKm: number | null): number | null {
  if (distanceKm == null || !Number.isFinite(distanceKm)) return null;
  return Math.max(1, Math.ceil(distanceKm)) * MINS_PER_KM;
}

const driverIdOf = (route: TimelineRoute): string | null => {
  // routeId is "driver_<uuid>"; the stops carry the same id, and either is fine.
  // Reading it off the route survives a route whose stops were all filtered out.
  const raw = (route as TimelineRoute & { routeId?: string }).routeId ?? "";
  const m = /^driver_(.+)$/.exec(raw);
  return m ? m[1] : null;
};

/**
 * Cut one driver's day into legs.
 *
 * Only stops the driver actually finished can start a leg, so the sequence is
 * built from stops carrying a completion stamp, ordered by it.
 *
 * Attendance stops are dropped first. A chấm-công completion stamp is when a
 * button was tapped, not when a vehicle left a place — including them would
 * splice phantom legs into the day (a check-out tapped from home would invent a
 * ride across the city).
 */
/** A stop as read off the timeline, once it is known to have been completed. */
interface StopEntry { stop: TimelineStop; completed: string; arrived: string | null }

/** One VISIT: the driver being at a place once, however many jobs they worked there. */
interface Visit { stop: TimelineStop; arrived: string | null; departed: string }

/** Identity of a place. customer_id is the real answer; coordinates are the fallback
 *  for a stop that carries none, truncated to ~1 m so GPS jitter at one address does
 *  not read as two places. */
function placeKey(s: TimelineStop): string {
  if (s.customerId) return `c:${s.customerId}`;
  if (s.latitude != null && s.longitude != null) return `p:${s.latitude.toFixed(5)},${s.longitude.toFixed(5)}`;
  return `s:${s.stopId ?? Math.random()}`;
}

/**
 * Collapse CONSECUTIVE stops at the same place into one visit.
 *
 * A driver who collects three jobs at one clinic has three stops but made one
 * journey there. Left unmerged those produce two 0 km legs between a place and
 * itself, each handed the 4-minute floor target and each counted as a "chặng" —
 * so the driver's day is padded with trips they never rode, and the paperwork
 * time between the three jobs is scored as if it were slow riding.
 *
 * CONSECUTIVE ONLY, deliberately. A driver returning to the lab three times across
 * a day genuinely rode there three times; merging by place alone would erase two
 * real journeys. Only an unbroken run at one place is one visit.
 *
 * The merged visit ARRIVES at the earliest arrival of the run and DEPARTS at the
 * latest completion. That pairing is what makes the surrounding legs honest: the
 * inbound leg ends when the driver actually got there, and the outbound leg starts
 * when they actually left, rather than part-way through the work they did there.
 */
function mergeConsecutiveStops(ordered: StopEntry[]): Visit[] {
  const visits: Visit[] = [];
  for (const e of ordered) {
    const prev = visits[visits.length - 1];
    if (prev && placeKey(prev.stop) === placeKey(e.stop)) {
      // Earliest arrival wins. A null arrival must not beat a real one — the driver
      // did arrive, they just did not tap it on that particular job.
      if (e.arrived && (!prev.arrived || Date.parse(e.arrived) < Date.parse(prev.arrived))) {
        prev.arrived = e.arrived;
      }
      // Latest completion wins: they left when the last job there was finished.
      if (Date.parse(e.completed) > Date.parse(prev.departed)) {
        prev.departed = e.completed;
        prev.stop = e.stop; // carry the last job's ids, matching the departure stamp
      }
      continue;
    }
    visits.push({ stop: e.stop, arrived: e.arrived, departed: e.completed });
  }
  return visits;
}

export function legsForRoute(route: TimelineRoute, tripDate: string): TatLeg[] {
  const driverId = driverIdOf(route);
  if (!driverId) return [];

  const driverName =
    (route as TimelineRoute & { driverFullname?: string | null }).driverFullname ?? null;

  const ordered = (route.orderedStops ?? [])
    .filter((s) => !isChamCong(s as unknown as { referenceNumber?: string | null; jobLabels?: unknown }))
    .map((s) => ({ stop: s, completed: toIso(s.activityCompletedTs), arrived: toIso(s.activityArrivedTs) }))
    .filter((e): e is { stop: TimelineStop; completed: string; arrived: string | null } => e.completed !== null)
    .sort((a, b) => Date.parse(a.completed) - Date.parse(b.completed));

  const visits = mergeConsecutiveStops(ordered);
  const legs: TatLeg[] = [];

  for (let i = 0; i < visits.length - 1; i++) {
    const from = visits[i];
    const to = visits[i + 1];

    // Prefer the next visit's arrival; fall back to its departure when the driver
    // never tapped "da den". tat_basis records which was used, so an inferred leg
    // (which includes time spent at the destination) can be told apart later.
    const byArrival = minutesBetween(from.departed, to.arrived);
    const byCompletion = byArrival == null ? minutesBetween(from.departed, to.departed) : null;
    const tatMins = byArrival ?? byCompletion;
    const basis: TatLeg["tat_basis"] = byArrival != null ? "arrived" : byCompletion != null ? "completed" : null;

    const f = from.stop;
    const t = to.stop;

    legs.push({
      trip_date: tripDate,
      driver_id: driverId,
      driver_name: driverName,
      seq: legs.length + 1,

      from_stop_id: f.stopId ?? null,
      from_job_id: f.jobId ?? null,
      from_customer_id: f.customerId ?? null,
      from_name: f.customerName ?? null,
      from_lat: f.latitude ?? null,
      from_lng: f.longitude ?? null,
      departed_ts: from.departed,

      to_stop_id: t.stopId ?? null,
      to_job_id: t.jobId ?? null,
      to_customer_id: t.customerId ?? null,
      to_name: t.customerName ?? null,
      to_lat: t.latitude ?? null,
      to_lng: t.longitude ?? null,
      arrived_ts: to.arrived ?? to.departed,

      tat_mins: tatMins,
      tat_basis: basis,
      distance_km: null,
      target_mins: null,
      eta_mins: null,
      on_time: null,
      long_gap: false,
    });
  }

  return legs;
}

/**
 * Fill in distance_km / target_mins / on_time / long_gap, mutating in place.
 *
 * Every leg in the day goes into ONE roadDistancesForPairs call, which dedupes
 * the pairs and answers from the non-expiring Redis cache before touching Goong.
 * That matters: a fleet riding the same branch→lab legs daily converges on a warm
 * cache within days, after which archiving a day costs zero Goong requests. Only
 * genuinely new pairs are ever billed, and each is billed once.
 *
 * Legs whose stops carry no coordinates are left ungraded rather than haversined
 * — an ungraded leg is honest; one graded against a straight-line guess is not.
 */
export async function attachDistances(legs: TatLeg[]): Promise<void> {
  const measurable = legs.filter(
    (l) => l.from_lat != null && l.from_lng != null && l.to_lat != null && l.to_lng != null,
  );
  if (measurable.length === 0) return;

  const results = await roadDistancesForPairs(
    measurable.map((l) => ({
      from: { lat: l.from_lat!, lon: l.from_lng! },
      to: { lat: l.to_lat!, lon: l.to_lng! },
    })),
  );

  measurable.forEach((leg, i) => {
    const km = results[i]?.distance_km ?? null;
    if (km == null) return;
    leg.distance_km = Math.round(km * 100) / 100;
    leg.target_mins = targetMinsFor(leg.distance_km);
    const eta = results[i]?.eta_mins;
    leg.eta_mins = typeof eta === "number" && Number.isFinite(eta) ? Math.round(eta) : null;
    if (leg.tat_mins == null || leg.target_mins == null) return;

    leg.long_gap = leg.tat_mins - leg.target_mins > LONG_GAP_OVER_TARGET_MINS;
    // A wait is not a slow ride, so it carries no verdict at all rather than a
    // failing one. v_tat_daily's percentage counts only rows with a verdict.
    leg.on_time = leg.long_gap ? null : leg.tat_mins <= leg.target_mins;
  });
}

/** The whole pipeline for one day: routes in, priced legs out. Shared by the
 *  archiver and any caller that wants a day without persisting it. */
export async function buildDayLegs(routes: TimelineRoute[], tripDate: string): Promise<TatLeg[]> {
  const legs = routes.flatMap((r) => legsForRoute(r, tripDate));
  await attachDistances(legs);
  return legs;
}

// ── Rollups ─────────────────────────────────────────────────────────────────

export interface TatSummary {
  trips_total: number;
  trips_measured: number;
  trips_graded: number;
  trips_on_time: number;
  long_gaps: number;
  on_time_pct: number | null;
  avg_tat_mins: number | null;
  total_tat_mins: number;
  total_km: number;
}

export interface TatRollupRow {
  trips_total: number;
  trips_measured: number;
  trips_graded: number;
  trips_on_time: number;
  long_gaps: number;
  total_tat_mins: number | null;
  total_km: number | null;
}

/** Shape a set of daily rollup rows into the numbers the report shows.
 *
 *  The average runs over MEASURED, NON-GAP legs — which is what total_tat_mins
 *  already excludes in the view — so the divisor has to match. Dividing by every
 *  measured leg (gaps included) while the numerator excludes them would report an
 *  average lower than any real leg. */
export function summarize(rows: TatRollupRow[]): TatSummary {
  // Accumulator typed explicitly: without it TS infers its shape from the ROW
  // type, whose totals are nullable (Postgres sum() over an empty group is null),
  // and every arithmetic line below turns into a null error.
  const acc = rows.reduce<Omit<TatSummary, "on_time_pct" | "avg_tat_mins">>(
    (a, r) => ({
      trips_total: a.trips_total + (r.trips_total || 0),
      trips_measured: a.trips_measured + (r.trips_measured || 0),
      trips_graded: a.trips_graded + (r.trips_graded || 0),
      trips_on_time: a.trips_on_time + (r.trips_on_time || 0),
      long_gaps: a.long_gaps + (r.long_gaps || 0),
      total_tat_mins: a.total_tat_mins + (Number(r.total_tat_mins) || 0),
      total_km: a.total_km + (Number(r.total_km) || 0),
    }),
    { trips_total: 0, trips_measured: 0, trips_graded: 0, trips_on_time: 0, long_gaps: 0, total_tat_mins: 0, total_km: 0 },
  );

  const avgOver = Math.max(0, acc.trips_measured - acc.long_gaps);

  return {
    ...acc,
    total_km: Math.round(acc.total_km * 10) / 10,
    on_time_pct: acc.trips_graded > 0 ? Math.round((acc.trips_on_time / acc.trips_graded) * 100) : null,
    avg_tat_mins: avgOver > 0 ? Math.round(acc.total_tat_mins / avgOver) : null,
  };
}

/** Rollup over the legs themselves, for the today span where we hold the rows
 *  rather than v_tat_daily's summary of them. */
export function summarizeLegs(
  legs: Pick<TatLeg, "tat_mins" | "on_time" | "distance_km" | "long_gap">[],
): TatSummary {
  return summarize([
    {
      trips_total: legs.length,
      trips_measured: legs.filter((l) => l.tat_mins != null).length,
      trips_graded: legs.filter((l) => l.on_time != null).length,
      trips_on_time: legs.filter((l) => l.on_time === true).length,
      long_gaps: legs.filter((l) => l.long_gap).length,
      total_tat_mins: legs.reduce((s, l) => s + (l.long_gap ? 0 : l.tat_mins ?? 0), 0),
      total_km: legs.reduce((s, l) => s + (Number(l.distance_km) || 0), 0),
    },
  ]);
}
