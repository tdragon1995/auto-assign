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
 * ...EXCEPT THAT IT CANNOT START BEFORE THE WORK EXISTED.
 *   If the next job was only created an hour after the driver finished the last
 *   one, that hour is not theirs to have spent better. Measured over three days:
 *   of 256 legs flagged as waits, 172 were the job simply not existing yet, at a
 *   median 91 minutes charged to the driver each. Left alone the effect runs
 *   backwards — the quieter the day, the worse the driver scores — so the clock
 *   starts at the LATER of leaving the last stop and the job becoming available.
 *   See availabilityOf().
 *
 * THE TARGET — max(1, ceil(km)) * 4 minutes, i.e. an effective 15 km/h.
 *   Sounds slow read as a speed; it is not, once HCMC traffic, lights, parking
 *   and the walk into a clinic are inside the same number. The ceil is on whole
 *   kilometres so a driver can check the target in their head: 7 km → 28 minutes.
 */
import { roadDistancesForPairs } from "./distance-cache";
import { newFallbackState, type QuotaSignal } from "./distance";
import { isChamCong } from "./job-filters";
import type { TimelineRoute, TimelineStop } from "./types";

/** Where a day's distance answers came from. Surfaced by the archive so the cost
 *  of a backfill is visible rather than inferred from wall-clock time, and so
 *  "why are 33% of legs ungraded" has a direct answer instead of a hypothesis. */
export interface DistanceStats {
  /** Legs with usable coordinates, i.e. pairs actually looked up. */
  pairs: number;
  cache: number;
  /** Billed Goong requests. The only line that costs money. */
  api: number;
  /** Origin == destination; answered as 0 km without any lookup. */
  self: number;
  /** Looked up and came back with nothing — these legs stay ungraded. */
  failed: number;
  /** Legs skipped entirely because a stop carried no coordinates. */
  noCoords: number;
}

/** Minutes allowed per whole kilometre. The single number a supervisor is most
 *  likely to want to tune — everything else derives from it. */
export const MINS_PER_KM = 4;

/**
 * How far past its benchmark a leg runs before it is labelled a WAIT rather than a
 * slow ride — a meal break, or time held at a clinic waiting for samples.
 *
 * These ARE graded: a wait that long missed its benchmark and counts as late, the
 * same as any other leg. The flag is a label, not an exemption — it exists so the
 * screen can show WHY a leg ran long, and so a supervisor can tell a slow ride
 * from a stationary hour without either disappearing from the numbers.
 *
 * (They were previously excluded from grading, which kept a lunch break from
 * reading as "trễ 130 phút" but also hid roughly 11% of every day from the
 * on-time figure entirely.)
 *
 * Measured against the FAIR clock, so a leg only reaches this threshold on time
 * the driver could actually have used. Time before the next job existed has
 * already been taken out by then — which is what makes grading waits defensible
 * rather than merely strict.
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

  /** The GRADED clock: fair start → arrival. Raw elapsed time is not lost —
   *  departed_ts and arrived_ts are both on the row, so tat_mins + idle_mins
   *  reconstructs it. */
  tat_mins: number | null;
  tat_basis: "arrived" | "completed" | null;
  /** When the destination job became available, if that moved this leg's start.
   *  Null means nothing was deducted — either the job already existed when the
   *  driver left, or its availability post-dated their arrival. Stored so a
   *  disputed verdict can be explained rather than asserted. */
  available_at: string | null;
  /** Minutes excluded because the job did not exist yet. Zero on most legs. */
  idle_mins: number;
  distance_km: number | null;
  target_mins: number | null;
  /** Goong's own travel-time estimate for this leg. REFERENCE ONLY — it never
   *  grades anything. Kept beside target_mins so a late leg can be read as either
   *  "the driver was slow" or "this route is slow", which a flat per-km rule
   *  cannot distinguish on its own. Comes free: Goong returns duration in the same
   *  response as distance, and the cache has stored both all along. */
  eta_mins: number | null;
  /** The number this leg was actually graded against: the HIGHER of the flat rule
   *  and Goong's estimate. Where the road is genuinely slow the estimate lifts the
   *  bar to something achievable; where Goong is optimistic the flat rule holds the
   *  floor, so no target is ever tighter than the flat rule alone. */
  benchmark_mins: number | null;
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

/** Whole minutes from an instant to a timestamp. A negative span means the stamps
 *  are out of order — a driver catching up on taps after the fact — which is not a
 *  measurement, so it is dropped rather than clamped to zero. */
function minsFrom(startMs: number, endIso: string | null): number | null {
  if (!endIso || !Number.isFinite(startMs)) return null;
  const ms = Date.parse(endIso) - startMs;
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60_000);
}

/**
 * Delivery windows arrive TIME-ONLY ("11:00:00+07"), so they mean nothing as an
 * instant until a date is attached. The stop's own deliveryDate is authoritative;
 * the trip date stands in for a stop that carries none.
 *
 * The EARLIEST window opening wins when a stop has several. A driver serving the
 * afternoon window of a job that also had a morning one could have set off in the
 * morning, so the later window would deduct time they did have available.
 */
function windowOpensAt(s: TimelineStop, tripDate: string): string | null {
  const windows = Array.isArray(s.deliveryWindows) ? s.deliveryWindows : [];
  let earliest: string | null = null;
  for (const w of windows) {
    const m = typeof w?.timeFrom === "string" ? /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(w.timeFrom) : null;
    if (!m) continue;
    const date = typeof s.deliveryDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(s.deliveryDate)
      ? s.deliveryDate.slice(0, 10)
      : tripDate;
    const iso = `${date}T${m[1]}:${m[2]}:${m[3] ?? "00"}+07:00`;
    if (!earliest || Date.parse(iso) < Date.parse(earliest)) earliest = iso;
  }
  return earliest;
}

/**
 * The earliest moment the driver could have set off toward this stop, as epoch ms.
 *
 * The LATEST of every condition that had to be met, because they are conjunctive:
 * a job pushed to the driver at 09:00 but not startable until 11:00 was not
 * rideable at 09:00. Coverage across 4,304 stops — scheduledDeliveryTs 100%,
 * sendToDriverAt 18%, allowedToStartAt 8%, delivery windows 4% — so the scheduled
 * stamp does the bulk of the work and the others sharpen it where present.
 *
 * Windows are low-volume but high-precision: on the 25 flagged waits that had one,
 * the window alone cleared 11 that no other stamp explained.
 */
function availabilityOf(s: TimelineStop, tripDate: string): number | null {
  const stamps = [
    toIso(s.sendToDriverAt),
    toIso(s.allowedToStartAt),
    toIso(s.scheduledDeliveryTs),
    windowOpensAt(s, tripDate),
  ]
    .map((iso) => (iso ? Date.parse(iso) : NaN))
    .filter((ms) => Number.isFinite(ms));
  return stamps.length > 0 ? Math.max(...stamps) : null;
}

/** Minutes a leg of this length is allowed. Null distance → no target, and the
 *  leg is reported but left ungraded rather than being guessed at. */
export function targetMinsFor(distanceKm: number | null): number | null {
  if (distanceKm == null || !Number.isFinite(distanceKm)) return null;
  return Math.max(1, Math.ceil(distanceKm)) * MINS_PER_KM;
}

/**
 * The number a leg is graded against: the HIGHER of the flat per-km rule and
 * Goong's estimate for that road.
 *
 * The flat rule is the FLOOR, never the ceiling — a missing or optimistic estimate
 * can only ever leave the target where it already was, so no driver's bar gets
 * tighter than the rule they already know. A slow road raises it; nothing lowers it.
 */
export function benchmarkMinsFor(targetMins: number | null, etaMins: number | null): number | null {
  if (targetMins == null) return null;
  return Math.max(targetMins, etaMins ?? 0);
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
interface StopEntry {
  stop: TimelineStop;
  completed: string;
  arrived: string | null;
  /** Epoch ms, or null when the stop carries no availability stamp at all. */
  available: number | null;
}

/** One VISIT: the driver being at a place once, however many jobs they worked there. */
interface Visit {
  stop: TimelineStop;
  arrived: string | null;
  departed: string;
  available: number | null;
}

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
      // EARLIEST availability wins across a merged visit, the opposite of the rule
      // within a single stop. The driver rode there once, and the first job that
      // existed is what let them go — a later sibling job cannot retroactively
      // make that journey unavailable.
      if (e.available != null && (prev.available == null || e.available < prev.available)) {
        prev.available = e.available;
      }
      continue;
    }
    visits.push({ stop: e.stop, arrived: e.arrived, departed: e.completed, available: e.available });
  }
  return visits;
}

/** The central lab, and any branch, as they are named in Cartrack's customer
 *  records ("BRA - D001", "BRA - D014"). */
const CENTRAL_LAB_NAME = "BRA - D001";
const BRANCH_NAME = /^BRA\s*-\s*D\d+$/;

/**
 * The outbound run from the lab to a branch is not measured.
 *
 * It carries no samples and no deadline — the driver is repositioning, usually
 * on the way to the next collection, and how long it takes is a routing decision
 * rather than a performance one. Measured over August it is 2,457 legs, ~15% of
 * everything, all of it graded against a target that describes nothing anyone is
 * managing.
 *
 * ONE DIRECTION ONLY. Branch → lab is the sample run: it is the whole point of
 * the fleet, it is time-critical, and it stays measured.
 */
function isUnmeasuredOutbound(fromName: string | null, toName: string | null): boolean {
  return fromName === CENTRAL_LAB_NAME && toName !== CENTRAL_LAB_NAME && BRANCH_NAME.test(toName ?? "");
}

export function legsForRoute(route: TimelineRoute, tripDate: string): TatLeg[] {
  const driverId = driverIdOf(route);
  if (!driverId) return [];

  const driverName =
    (route as TimelineRoute & { driverFullname?: string | null }).driverFullname ?? null;

  const ordered = (route.orderedStops ?? [])
    .filter((s) => !isChamCong(s as unknown as { referenceNumber?: string | null; jobLabels?: unknown }))
    .map((s) => ({
      stop: s,
      completed: toIso(s.activityCompletedTs),
      arrived: toIso(s.activityArrivedTs),
      available: availabilityOf(s, tripDate),
    }))
    .filter((e): e is StopEntry => e.completed !== null)
    .sort((a, b) => Date.parse(a.completed) - Date.parse(b.completed));

  const visits = mergeConsecutiveStops(ordered);
  const legs: TatLeg[] = [];

  for (let i = 0; i < visits.length - 1; i++) {
    const from = visits[i];
    const to = visits[i + 1];

    // Dropped before any measuring happens, so it never reaches the row count,
    // the on-time percentage or the driver's screen. Skipping a pair leaves the
    // legs either side of it untouched — they are consecutive visits, not a chain
    // that needs relinking.
    if (isUnmeasuredOutbound(from.stop.customerName ?? null, to.stop.customerName ?? null)) continue;

    // Prefer the next visit's arrival; fall back to its departure when the driver
    // never tapped "da den". tat_basis records which was used, so an inferred leg
    // (which includes time spent at the destination) can be told apart later.
    const reachedIso = to.arrived ?? to.departed;
    const departedMs = Date.parse(from.departed);
    const reachedMs = Date.parse(reachedIso);

    // FAIR START. The clock begins when the driver left the last stop, or when the
    // next job became theirs to ride toward — whichever is later.
    //
    // Availability that post-dates the ARRIVAL is discarded rather than clamped.
    // The driver was already standing there, so it says nothing about when they
    // could have set off; honouring it would zero the leg and hand a free pass to
    // every planned job whose slot time sits after the run that served it. That
    // leaves a handful of "arrived before the window opened" legs still reading as
    // waits, which is the conservative error to make — the flag explains them, and
    // no driver is credited for a ride the data cannot vouch for.
    const avail = to.available;
    const startMs = avail != null && avail > departedMs && avail < reachedMs ? avail : departedMs;
    const deducts = startMs !== departedMs;

    const byArrival = minsFrom(startMs, to.arrived);
    const byCompletion = byArrival == null ? minsFrom(startMs, to.departed) : null;
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
      available_at: deducts ? new Date(startMs).toISOString() : null,
      idle_mins: deducts ? Math.round((startMs - departedMs) / 60_000) : 0,
      distance_km: null,
      target_mins: null,
      eta_mins: null,
      benchmark_mins: null,
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
export async function attachDistances(legs: TatLeg[]): Promise<DistanceStats> {
  const stats: DistanceStats = { pairs: 0, cache: 0, api: 0, self: 0, failed: 0, noCoords: 0 };
  const measurable = legs.filter(
    (l) => l.from_lat != null && l.from_lng != null && l.to_lat != null && l.to_lng != null,
  );
  stats.noCoords = legs.length - measurable.length;
  if (measurable.length === 0) return stats;

  // One quota signal for the whole day. Without it, a provider that has cut us off
  // is asked again for every single pair — measured at ~250 pointless 429s per day,
  // each a real round trip, which both slows the archive and keeps hammering an API
  // that is already refusing. The first 429 now short-circuits the rest straight to
  // the fallback. The fallback is deliberately NOT given this signal: one provider's
  // quota must never silence the other.
  // One signal PER PROVIDER, per day. Separate because either provider going quiet
  // must not silence the other — that is the entire point of having a fallback —
  // but each still needs its own brake, or a rate-limited provider is re-asked for
  // every remaining pair and the day is lost to 429s.
  const signal: QuotaSignal = { quotaExceeded: false };
  const fallback = newFallbackState();
  const results = await roadDistancesForPairs(
    measurable.map((l) => ({
      from: { lat: l.from_lat!, lon: l.from_lng! },
      to: { lat: l.to_lat!, lon: l.to_lng! },
    })),
    undefined,
    signal,
    fallback,
  );

  measurable.forEach((leg, i) => {
    stats.pairs++;
    const r = results[i];
    if (!r) { stats.failed++; return; }
    if (r.source === "cache") stats.cache++;
    else if (r.source === "api") stats.api++;
    else stats.self++;

    const km = r.distance_km ?? null;
    if (km == null) { stats.failed++; return; }
    leg.distance_km = Math.round(km * 100) / 100;
    leg.target_mins = targetMinsFor(leg.distance_km);
    const eta = results[i]?.eta_mins;
    leg.eta_mins = typeof eta === "number" && Number.isFinite(eta) ? Math.round(eta) : null;
    if (leg.tat_mins == null || leg.target_mins == null) return;

    // The higher of the two. Goong knows the road; the flat rule is the floor, so a
    // benchmark can never come out tighter than the rule drivers already know.
    // Held in a local so the comparisons below narrow: benchmarkMinsFor is
    // null-returning by contract (no distance → no benchmark), even though
    // target_mins has already been checked non-null a few lines up.
    const bench = benchmarkMinsFor(leg.target_mins, leg.eta_mins);
    if (bench == null) return;
    leg.benchmark_mins = bench;

    // The flag LABELS the leg; it no longer excuses it. Every priced leg gets a
    // verdict, so the on-time figure now covers the whole day rather than the ~89%
    // of it that was not a wait.
    leg.long_gap = leg.tat_mins - bench > LONG_GAP_OVER_TARGET_MINS;
    leg.on_time = leg.tat_mins <= bench;
  });

  return stats;
}

/** The whole pipeline for one day: routes in, priced legs out. Shared by the
 *  archiver and any caller that wants a day without persisting it. */
export async function buildDayLegs(
  routes: TimelineRoute[], tripDate: string,
): Promise<{ legs: TatLeg[]; stats: DistanceStats }> {
  const legs = routes.flatMap((r) => legsForRoute(r, tripDate));
  const stats = await attachDistances(legs);
  return { legs, stats };
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
