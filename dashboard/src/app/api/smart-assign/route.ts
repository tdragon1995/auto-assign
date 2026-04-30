import { NextRequest, NextResponse } from "next/server";
import { getDrivers, getUnassignedJobs, getFleetwebCookie, getCustomerById, type Env } from "@/lib/cartrack";
import { vnDate, vnDayWindow } from "@/lib/time";

const JSONRPC_URL = "https://fleetweb-vn.cartrack.com/jsonrpc/index.php";
const TOP_N        = 3;
const PRE_FILTER_N = 10;
const GOONG_API    = "https://rsapi.goong.io/v2/distancematrix";

// ── Haversine (pre-filter only) ────────────────────────────────────────────

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ── Goong Distance Matrix v2 ───────────────────────────────────────────────

async function goongMatrix(
  originLat: number,
  originLon: number,
  destinations: { lat: number; lon: number }[]
): Promise<({ distance_km: number; eta_mins: number } | null)[]> {
  const apiKey = process.env.GOONG_API_KEY ?? "";
  if (!apiKey || destinations.length === 0) return destinations.map(() => null);

  const destStr = destinations.map((d) => `${d.lat},${d.lon}`).join("|");
  const url = `${GOONG_API}?origins=${originLat},${originLon}&destinations=${encodeURIComponent(destStr)}&vehicle=bike&api_key=${apiKey}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return destinations.map(() => null);
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
  } catch {
    return destinations.map(() => null);
  }
}

// ── Driver route data (one call for all drivers) ───────────────────────────

interface DriverJobStats {
  total: number;
  active: number;
  done: number;
}

export type DetourLabel = "Arrived" | "En Route" | "Next Stop" | "First Stop" | "Start Location";

interface DriverRouteData {
  stats: DriverJobStats;
  referenceStop: { lat: number; lon: number; label: DetourLabel; customerName: string | null } | null;
  lastCompletedTs: string | null;
}

const ACTIVE_STOP_STATUSES = new Set([1, 2, 3]);
const GPS_FRESH_MS = 15 * 60 * 1000;

async function fetchAllDriverRouteData(
  dateVn: string,
  auth: string,
  cookie: string
): Promise<Record<string, DriverRouteData>> {
  try {
    const res = await fetch(JSONRPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth, Cookie: cookie },
      body: JSON.stringify({
        version: "2.0",
        method: "delivery_timeline_route_list",
        id: 1,
        params: {
          data: {
            scheduleType: "scheduled",
            filter: vnDayWindow(dateVn),
          },
        },
      }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const routes: {
      routeId: string;
      orderedStops?: { jobId: number; stopId: number; stopStatusId: number; latitude: number; longitude: number; customerName?: string; activityCompletedTs?: string }[];
    }[] = data.result?.routes ?? [];

    const result: Record<string, DriverRouteData> = {};
    for (const route of routes) {
      const driverId = route.routeId.replace(/^driver_/, "");
      const stops = route.orderedStops ?? [];

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

      // Reference stop logic:
      //   Arrived (3) → "Arrived"
      //   En Route (2) → "En Route"
      //   Completed (4) + pending (1) after it → next pending, "Next Stop"
      //   All pending (1) → first stop, "First Stop" (may be overridden to null later if GPS is fresh)
      //   All completed / empty → null (falls back to GPS)
      const validStops = stops.filter((s) => s.latitude && s.longitude);
      const arrivedStop = validStops.find((s) => s.stopStatusId === 3) ?? null;
      const enRouteStop = validStops.find((s) => s.stopStatusId === 2) ?? null;

      let referenceStop: DriverRouteData["referenceStop"] = null;
      if (arrivedStop) {
        referenceStop = { lat: arrivedStop.latitude, lon: arrivedStop.longitude, label: "Arrived", customerName: arrivedStop.customerName ?? null };
      } else if (enRouteStop) {
        referenceStop = { lat: enRouteStop.latitude, lon: enRouteStop.longitude, label: "En Route", customerName: enRouteStop.customerName ?? null };
      } else if (validStops.length > 0) {
        let lastCompletedIdx = -1;
        for (let i = validStops.length - 1; i >= 0; i--) {
          if (validStops[i].stopStatusId === 4) { lastCompletedIdx = i; break; }
        }
        if (lastCompletedIdx === -1) {
          // No completed, no arrived/en-route → all pending
          const allPending = validStops.every((s) => s.stopStatusId === 1);
          if (allPending) {
            const first = validStops[0];
            referenceStop = { lat: first.latitude, lon: first.longitude, label: "First Stop", customerName: first.customerName ?? null };
          }
        } else {
          const nextPending = validStops.slice(lastCompletedIdx + 1).find((s) => s.stopStatusId === 1);
          if (nextPending) {
            referenceStop = { lat: nextPending.latitude, lon: nextPending.longitude, label: "Next Stop", customerName: nextPending.customerName ?? null };
          }
        }
      }

      // Latest completion timestamp across all status=4 stops
      let lastCompletedTs: string | null = null;
      for (const stop of stops) {
        if (stop.stopStatusId !== 4 || !stop.activityCompletedTs) continue;
        if (!lastCompletedTs || stop.activityCompletedTs > lastCompletedTs) {
          lastCompletedTs = stop.activityCompletedTs;
        }
      }

      result[driverId] = { stats: { total, active, done: total - active }, referenceStop, lastCompletedTs };
    }
    return result;
  } catch {
    return {};
  }
}

// ── Main handler ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  const today = vnDate();

  const auth   = process.env.CARTRACK_AUTH ?? "";
  const cookie = await getFleetwebCookie();

  const [allDrivers, jobsRes, routeData] = await Promise.all([
    getDrivers(env),
    getUnassignedJobs(1, 50, env),
    cookie
      ? fetchAllDriverRouteData(today, auth, cookie)
      : Promise.resolve({} as Record<string, DriverRouteData>),
  ]);

  const EXCLUDED_DRIVER_STATUSES = new Set([3, 4, 5]);
  // Include drivers without GPS if they have a start_location (used as Phase 1 fallback)
  const drivers = allDrivers.filter(
    (d) => !EXCLUDED_DRIVER_STATUSES.has(d.driver_status_id ?? 4) &&
      ((d.latitude != null && d.longitude != null) || !!d.start_location_customer_id)
  );

  // ── GPS-fresh override: if driver hasn't started (First Stop) but GPS is fresh, use GPS instead ──
  const nowMs = Date.now();
  for (const d of drivers) {
    const rd = routeData[d.delivery_driver_id];
    if (rd?.referenceStop?.label !== "First Stop") continue;
    if (!d.last_login_ts) continue;
    const loginMs = new Date(d.last_login_ts).getTime();
    if (!Number.isFinite(loginMs)) continue;
    if (nowMs - loginMs < GPS_FRESH_MS) {
      routeData[d.delivery_driver_id] = { ...rd, referenceStop: null };
    }
  }

  // ── Fetch start_location coords for drivers who need them ──
  // Two reasons: (1) no GPS → Phase 1 fallback, (2) no route today → reference-stop fallback.
  const customerIdsNeeded = new Set<string>();
  for (const d of drivers) {
    if (!d.start_location_customer_id) continue;
    const noGps = d.latitude == null || d.longitude == null;
    const rd = routeData[d.delivery_driver_id];
    const needsRefFallback = !rd?.referenceStop && (!rd || rd.stats.total === 0);
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

  // Apply reference-stop fallback (only for drivers with no route today)
  for (const d of drivers) {
    if (!d.start_location_customer_id) continue;
    const rd = routeData[d.delivery_driver_id];
    if (rd?.referenceStop) continue;
    if (rd && rd.stats.total > 0) continue;
    const coords = customerCoords.get(d.start_location_customer_id);
    if (!coords) continue;
    const existing = rd ?? { stats: { total: 0, active: 0, done: 0 }, referenceStop: null, lastCompletedTs: null };
    routeData[d.delivery_driver_id] = {
      ...existing,
      referenceStop: { lat: coords.lat, lon: coords.lon, label: "Start Location", customerName: coords.name },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobs = ((jobsRes.data ?? []) as any[])
    .filter((j) => { const ts = j.scheduled_delivery_ts ?? null; return !ts || ts.startsWith(today); })
    .sort((a, b) => (a.create_ts ?? "").localeCompare(b.create_ts ?? ""));

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
    const key = `${ref.lat},${ref.lon}`;
    if (!originToDrivers.has(key)) {
      originToDrivers.set(key, []);
      originCoords.set(key, { lat: ref.lat, lon: ref.lon });
    }
    originToDrivers.get(key)!.push(driverId);
  }

  if (originToDrivers.size > 0 && intermediate.length > 0) {
    await Promise.all(
      [...originToDrivers.entries()].map(async ([originKey, driverIds]) => {
        const from    = originCoords.get(originKey)!;
        const pickups = intermediate.map((s) => ({ jobId: s.job_id, lat: s.pickup_lat, lon: s.pickup_lon }));
        const results = await goongMatrix(from.lat, from.lon, pickups.map((p) => ({ lat: p.lat, lon: p.lon })));
        pickups.forEach((p, i) => {
          for (const driverId of driverIds) {
            detourRoutingMap.set(`${p.jobId}:${driverId}`, results[i]);
          }
        });
      })
    );
  }

  // ── Assemble + re-rank by Goong detour, take top 3 ────────────────────────
  const suggestions = intermediate.map((s) => {
    const rankedDrivers = s.drivers
      .map((d) => {
        const ref           = routeData[d.driver_id]?.referenceStop ?? null;
        const detourRouting = detourRoutingMap.get(`${s.job_id}:${d.driver_id}`) ?? null;
        const detourHaversineKm = ref
          ? Math.round(haversineKm(ref.lat, ref.lon, s.pickup_lat, s.pickup_lon) * 10) / 10
          : null;

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
        };
      })
      // Re-rank: Goong detour (fallback detour haversine → GPS haversine)
      //   → last_completed_ts ASC (null = most idle = highest priority)
      //   → jobs_done ASC (fewer jobs done today = higher priority)
      .sort((a, b) => {
        const aDist = a.detour_distance_km ?? a.detour_haversine_km ?? a.haversine_km;
        const bDist = b.detour_distance_km ?? b.detour_haversine_km ?? b.haversine_km;
        if (aDist !== bDist) return aDist - bDist;
        const aTs = a.last_completed_ts ?? "";
        const bTs = b.last_completed_ts ?? "";
        if (aTs !== bTs) return aTs.localeCompare(bTs);
        return (a.jobs_done ?? 0) - (b.jobs_done ?? 0);
      })
      .slice(0, TOP_N);

    return { job_id: s.job_id, pickup: s.pickup, unscheduled: s.unscheduled, drivers: rankedDrivers };
  });

  return NextResponse.json({ suggestions, unmatched, drivers_with_gps: drivers.length });
}
