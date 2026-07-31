import { NextRequest, NextResponse } from "next/server";
import { getDrivers, getJobsByStatusAndDate, getCustomerById, getTimelineRoutes, type Env } from "@/lib/cartrack";
import { vnDate, vnMinutesSinceMidnight } from "@/lib/time";
import { haversineKm } from "@/lib/distance";
import { roadDistancesFromPoint, roadDistancesToPoint } from "@/lib/distance-cache";
import { selectReferenceStop, computeStopStats, ROUTE_STATE_PRIORITY, enRouteGpsBand, idleBand, type RefLabel } from "@/lib/smart-rank";
import { isChamCong } from "@/lib/job-filters";

const TOP_N        = 3;
const PRE_FILTER_N = 10;

// ── Driver route data (one call for all drivers) ───────────────────────────

interface DriverJobStats {
  total: number;
  active: number;
  done: number;
}

interface DriverRouteData {
  stats: DriverJobStats;
  referenceStop: {
    lat: number; lon: number; label: RefLabel; customerName: string | null; tiebreakTs: string | null;
    altLat?: number | null; altLon?: number | null;
  } | null;
  lastCompletedTs: string | null;
}

const ACTIVE_STOP_STATUSES = new Set([1, 2, 3]);

async function fetchAllDriverRouteData(
  dateVn: string,
  env: Env,
  shiftStartByDriverId: Record<string, string | null>
): Promise<Record<string, DriverRouteData>> {
  try {
    const routes = await getTimelineRoutes(dateVn, env);
    if (!routes) return {};

    const result: Record<string, DriverRouteData> = {};
    for (const route of routes) {
      const driverId = route.routeId.replace(/^driver_/, "");
      // Chấm công (check-in/out) stops are attendance records, not delivery work —
      // dropped before ranking so the preview matches the cycle (see assign.ts
      // timelineRoutesToDriverInfo). Also keeps the job counts shown to the
      // supervisor to real trips.
      const stops = (route.orderedStops ?? []).filter((s) => !isChamCong(s));

      // Job stats
      const jobStatuses = new Map<number, Set<number>>();
      for (const stop of stops) {
        if (!stop.jobId) continue;
        if (!jobStatuses.has(stop.jobId)) jobStatuses.set(stop.jobId, new Set());
        jobStatuses.get(stop.jobId)!.add(stop.stopStatusId);
      }
      const total = jobStatuses.size;
      let active = 0;
      for (const statuses of jobStatuses.values()) {
        if ([...statuses].some((s) => ACTIVE_STOP_STATUSES.has(s))) active++;
      }

      const referenceStop = selectReferenceStop(stops, shiftStartByDriverId[driverId] ?? null);
      const { lastCompletedTs } = computeStopStats(stops);

      result[driverId] = { stats: { total, active, done: total - active }, referenceStop, lastCompletedTs };
    }
    return result;
  } catch {
    return {};
  }
}

// ── Job list for the targeted-preview picker ───────────────────────────────

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const today = vnDate();

  const unassigned = await getJobsByStatusAndDate(2, today, env);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobs = ((unassigned ?? []) as any[])
    .filter((j) => { const ts = j.scheduled_delivery_ts ?? null; return !ts || ts.startsWith(today); })
    .sort((a, b) => (a.create_ts ?? "").localeCompare(b.create_ts ?? ""))
    .map((j) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stops = (j.stops ?? []) as any[];
      const pickup  = stops.find((s) => s.stop_type_id === 1);
      const dropoff = stops.find((s) => s.stop_type_id === 2) ?? stops.find((s) => s.stop_type_id === 3);
      return {
        job_id:      j.job_id,
        pickup:      pickup?.customer_name  ?? pickup?.customer_id  ?? "—",
        dropoff:     dropoff?.customer_name ?? dropoff?.customer_id ?? "—",
        unscheduled: !j.scheduled_delivery_ts,
      };
    });

  return NextResponse.json({ jobs });
}

// ── Main handler ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const jobIdParam = req.nextUrl.searchParams.get("job_id");
  const targetJobId = jobIdParam && /^\d+$/.test(jobIdParam) ? Number(jobIdParam) : null;

  const today = vnDate();

  const allDrivers = await getDrivers(env);
  const EXCLUDED_DRIVER_STATUSES = new Set([3, 4, 5]);
  // Include drivers without GPS if they have a start_location (used as Phase 1 fallback)
  const drivers = allDrivers.filter(
    (d) => !EXCLUDED_DRIVER_STATUSES.has(d.driver_status_id ?? 4) &&
      ((d.latitude != null && d.longitude != null) || !!d.start_location_customer_id)
  );
  const shiftStartByDriverId: Record<string, string | null> = {};
  for (const d of drivers) shiftStartByDriverId[d.delivery_driver_id] = d.shift_time_start ?? null;

  const [unassignedJobs, routeData] = await Promise.all([
    getJobsByStatusAndDate(2, today, env),
    fetchAllDriverRouteData(today, env, shiftStartByDriverId),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let jobs = ((unassignedJobs ?? []) as any[])
    .filter((j) => { const ts = j.scheduled_delivery_ts ?? null; return !ts || ts.startsWith(today); })
    .sort((a, b) => (a.create_ts ?? "").localeCompare(b.create_ts ?? ""));

  // Targeted mode: preview a single job instead of every unassigned job.
  if (targetJobId != null) {
    jobs = jobs.filter((j) => j.job_id === targetJobId);
    if (jobs.length === 0) {
      return NextResponse.json({
        suggestions: [],
        unmatched: [{ job_id: targetJobId, reason: "Not in today's unassigned jobs" }],
        drivers_with_gps: drivers.length,
      });
    }
  }

  // ── Fetch start_location coords for drivers who need them ──
  // Two reasons: (1) no GPS → Phase 1 fallback, (2) no route today → reference-stop fallback.
  const customerIdsNeeded = new Set<string>();
  for (const d of drivers) {
    if (!d.start_location_customer_id) continue;
    const noGps = d.latitude == null || d.longitude == null;
    const rd = routeData[d.delivery_driver_id];
    const needsRefFallback = !rd?.referenceStop;
    if (noGps || needsRefFallback) customerIdsNeeded.add(d.start_location_customer_id);
  }
  const customerCoords = new Map<string, { lat: number; lon: number; name: string | null }>();
  await Promise.all(
    [...customerIdsNeeded].map(async (cid) => {
      const res = await getCustomerById(cid, env);
      const c = res?.data;
      if (c?.latitude != null && c?.longitude != null) {
        customerCoords.set(cid, { lat: c.latitude, lon: c.longitude, name: c.customer_name ?? null });
      }
    })
  );

  // Reference-stop fallback: no usable ref (no route, or all stops windowed) → use start_location
  for (const d of drivers) {
    if (!d.start_location_customer_id) continue;
    const rd = routeData[d.delivery_driver_id];
    if (rd?.referenceStop) continue;
    const coords = customerCoords.get(d.start_location_customer_id);
    if (!coords) continue;
    const existing = rd ?? { stats: { total: 0, active: 0, done: 0 }, referenceStop: null, lastCompletedTs: null };
    routeData[d.delivery_driver_id] = {
      ...existing,
      referenceStop: {
        lat: coords.lat,
        lon: coords.lon,
        label: "Start Location",
        customerName: coords.name,
        tiebreakTs: d.shift_time_start ?? null,
      },
    };
  }

  // ── Phase 1: haversine pre-filter to top PRE_FILTER_N per job ─────────────
  const intermediate: {
    job_id: number;
    pickup: string;
    unscheduled: boolean;
    pickup_lat: number;
    pickup_lon: number;
    drivers: {
      driver_id: string;
      driver_name: string;
      haversine_km: number;
      status_id: number;
      last_login_ts: string | null;
      lat: number;
      lon: number;
    }[];
  }[] = [];

  const unmatched: { job_id: number; reason: string }[] = [];

  for (const job of jobs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickupStop = (job.stops as any[])?.find((s: any) => s.stop_type_id === 1);
    if (!pickupStop?.latitude || !pickupStop?.longitude) {
      unmatched.push({ job_id: job.job_id, reason: "No pickup GPS" });
      continue;
    }

    const preFiltered = drivers
      .map((d) => {
        // Effective coords: GPS if available, else start_location fallback
        const startCoords = d.start_location_customer_id ? customerCoords.get(d.start_location_customer_id) : undefined;
        const driverLat = d.latitude ?? startCoords?.lat;
        const driverLon = d.longitude ?? startCoords?.lon;
        if (driverLat == null || driverLon == null) return null;
        return {
          driver_id:    d.delivery_driver_id,
          driver_name:  d.last_name?.trim() || `${d.first_name} ${d.last_name}`.trim(),
          haversine_km: Math.round(haversineKm(pickupStop.latitude, pickupStop.longitude, driverLat, driverLon) * 10) / 10,
          status_id:    d.driver_status_id ?? 4,
          last_login_ts: d.last_login_ts ?? null,
          lat: driverLat,
          lon: driverLon,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.haversine_km - b.haversine_km)
      .slice(0, PRE_FILTER_N);

    intermediate.push({
      job_id: job.job_id,
      pickup: pickupStop.customer_name ?? pickupStop.customer_id ?? "—",
      unscheduled: !job.scheduled_delivery_ts,
      pickup_lat: pickupStop.latitude,
      pickup_lon: pickupStop.longitude,
      drivers: preFiltered,
    });
  }

  // ── Phase 2: Goong reference stop → pickup (ranking metric) ───────────────
  // Group pre-filtered drivers by unique reference stop coordinate to minimise Goong calls
  type RouteResult = { distance_km: number; eta_mins: number } | null;
  const detourRoutingMap = new Map<string, RouteResult>(); // key: `${job_id}:${driver_id}`

  const relevantDriverIds = new Set(intermediate.flatMap((s) => s.drivers.map((d) => d.driver_id)));

  const originToDrivers = new Map<string, string[]>();
  const originCoords    = new Map<string, { lat: number; lon: number }>();

  for (const driverId of relevantDriverIds) {
    const ref = routeData[driverId]?.referenceStop;
    if (!ref) continue;
    // Primary ref + (for "Next Stop") the last completed stop. Each becomes a
    // Goong origin; the min distance across them is taken when assembling.
    const pts: { lat: number; lon: number }[] = [{ lat: ref.lat, lon: ref.lon }];
    if (ref.altLat != null && ref.altLon != null) pts.push({ lat: ref.altLat, lon: ref.altLon });
    for (const pt of pts) {
      const key = `${pt.lat},${pt.lon}`;
      if (!originToDrivers.has(key)) {
        originToDrivers.set(key, []);
        originCoords.set(key, pt);
      }
      originToDrivers.get(key)!.push(driverId);
    }
  }

  if (originToDrivers.size > 0 && intermediate.length === 1) {
    // Single job: all origins → the one pickup fits in ONE multi-origin request.
    const s = intermediate[0];
    const originKeys = [...originToDrivers.keys()];
    const results = await roadDistancesToPoint(
      originKeys.map((k) => originCoords.get(k)!),
      { lat: s.pickup_lat, lon: s.pickup_lon }
    );
    originKeys.forEach((originKey, i) => {
      const cand = results[i];
      for (const driverId of originToDrivers.get(originKey)!) {
        const mapKey = `${s.job_id}:${driverId}`;
        const existing = detourRoutingMap.get(mapKey);
        if (existing == null) {
          detourRoutingMap.set(mapKey, cand);
        } else if (cand != null && cand.distance_km < existing.distance_km) {
          detourRoutingMap.set(mapKey, cand);
        }
      }
    });
  } else if (originToDrivers.size > 0 && intermediate.length > 0) {
    await Promise.all(
      [...originToDrivers.entries()].map(async ([originKey, driverIds]) => {
        const from    = originCoords.get(originKey)!;
        const pickups = intermediate.map((s) => ({ jobId: s.job_id, lat: s.pickup_lat, lon: s.pickup_lon }));
        const results = await roadDistancesFromPoint(from, pickups.map((p) => ({ lat: p.lat, lon: p.lon })));
        pickups.forEach((p, i) => {
          for (const driverId of driverIds) {
            const mapKey = `${p.jobId}:${driverId}`;
            const cand = results[i];
            const existing = detourRoutingMap.get(mapKey);
            // A driver may have 2 origins (next + last completed); keep the min.
            if (existing == null) {
              detourRoutingMap.set(mapKey, cand);
            } else if (cand != null && cand.distance_km < existing.distance_km) {
              detourRoutingMap.set(mapKey, cand);
            }
          }
        });
      })
    );
  }

  // ── Assemble + re-rank by Goong detour, take top 3 ────────────────────────
  const nowMin = vnMinutesSinceMidnight();
  const suggestions = intermediate.map((s) => {
    const rankedDrivers = s.drivers
      .map((d) => {
        const ref           = routeData[d.driver_id]?.referenceStop ?? null;
        const detourRouting = detourRoutingMap.get(`${s.job_id}:${d.driver_id}`) ?? null;
        let detourHaversineKm: number | null = null;
        if (ref) {
          let best = haversineKm(ref.lat, ref.lon, s.pickup_lat, s.pickup_lon);
          if (ref.altLat != null && ref.altLon != null) {
            best = Math.min(best, haversineKm(ref.altLat, ref.altLon, s.pickup_lat, s.pickup_lon));
          }
          detourHaversineKm = Math.round(best * 10) / 10;
        }

        return {
          driver_id:           d.driver_id,
          driver_name:         d.driver_name,
          haversine_km:        d.haversine_km,
          status_id:           d.status_id,
          last_login_ts:       d.last_login_ts,
          jobs_total:          routeData[d.driver_id]?.stats.total  ?? null,
          jobs_active:         routeData[d.driver_id]?.stats.active ?? null,
          jobs_done:           routeData[d.driver_id]?.stats.done   ?? null,
          last_completed_ts:   routeData[d.driver_id]?.lastCompletedTs ?? null,
          detour_label:        ref?.label        ?? null,
          detour_customer:     ref?.customerName ?? null,
          detour_haversine_km: detourHaversineKm,
          detour_distance_km:  detourRouting?.distance_km ?? null,
          detour_eta_mins:     detourRouting?.eta_mins    ?? null,
          _priority:           ref ? ROUTE_STATE_PRIORITY[ref.label] : 0,
          _tiebreakTs:         ref?.tiebreakTs ?? null,
          _idleBand:           idleBand(ref?.tiebreakTs ?? null, nowMin),
        };
      })
      // Re-rank: distance ASC → route-state priority DESC → en-route GPS band ASC
      //   → idle band DESC (idle longer first) → jobs_done ASC (within band) → tiebreak
      //   ts ASC. Mirrors rankingComparator; tiebreak ts semantics live in selectReferenceStop.
      .sort((a, b) => {
        const aDist = a.detour_distance_km ?? a.detour_haversine_km ?? a.haversine_km;
        const bDist = b.detour_distance_km ?? b.detour_haversine_km ?? b.haversine_km;
        if (aDist !== bDist) return aDist - bDist;
        if (a._priority !== b._priority) return b._priority - a._priority;
        const band = enRouteGpsBand(
          { label: a.detour_label, gpsKm: a.haversine_km },
          { label: b.detour_label, gpsKm: b.haversine_km }
        );
        if (band !== 0) return band;
        if (a._idleBand !== b._idleBand) return b._idleBand - a._idleBand;
        if ((a.jobs_done ?? 0) !== (b.jobs_done ?? 0)) return (a.jobs_done ?? 0) - (b.jobs_done ?? 0);
        const aTs = a._tiebreakTs ?? "";
        const bTs = b._tiebreakTs ?? "";
        return aTs.localeCompare(bTs);
      })
      .slice(0, TOP_N)
      // Drop internal sort keys before returning to client
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .map(({ _priority, _tiebreakTs, _idleBand, ...rest }) => rest);

    return { job_id: s.job_id, pickup: s.pickup, unscheduled: s.unscheduled, drivers: rankedDrivers };
  });

  return NextResponse.json({ suggestions, unmatched, drivers_with_gps: drivers.length });
}
