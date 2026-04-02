import { NextRequest, NextResponse } from "next/server";
import { getDrivers, getUnassignedJobs, getFleetwebCookie, type Env } from "@/lib/cartrack";

const JSONRPC_URL = "https://fleetweb-vn.cartrack.com/jsonrpc/index.php";
const TOP_N = 3;
const GOONG_API = "https://rsapi.goong.io/v2/distancematrix";

// ── Haversine ──────────────────────────────────────────────────────────────

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

// ── Valhalla ───────────────────────────────────────────────────────────────

async function valhallaRoute(
  fromLat: number, fromLon: number,
  toLat: number, toLon: number
): Promise<{ distance_km: number; eta_mins: number } | null> {
  try {
    const res = await fetch("https://valhalla1.openstreetmap.de/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        locations: [
          { lat: fromLat, lon: fromLon },
          { lat: toLat,   lon: toLon   },
        ],
        costing: "motorcycle",
        directions_options: { units: "km" },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const summary = data.trip?.summary;
    if (!summary) return null;
    return {
      distance_km: Math.round(summary.length * 10) / 10,
      eta_mins: Math.round(summary.time / 60),
    };
  } catch {
    return null;
  }
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
  active: number; // distinct jobs with any stop at status 1/2/3
  done: number;   // distinct jobs with all stops at status 4/5
}

interface DriverRouteData {
  stats: DriverJobStats;
  // Last stop in route sequence with stopStatusId=3 (Arrived).
  // "Last" = furthest along in planned order, so most likely their current physical position.
  // If multiple status=3 stops exist (e.g. driver skipped completion), we take the last one.
  arrivedStop: { jobId: number; stopId: number } | null;
}

const ACTIVE_STOP_STATUSES = new Set([1, 2, 3]);

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
            filter: {
              from: `${dateVn}T00:00:00+07:00`,
              to: `${dateVn}T23:59:59+07:00`,
            },
          },
        },
      }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const routes: {
      routeId: string;
      orderedStops?: { jobId: number; stopId: number; stopStatusId: number }[];
    }[] = data.result?.routes ?? [];

    const result: Record<string, DriverRouteData> = {};
    for (const route of routes) {
      const driverId = route.routeId.replace(/^driver_/, "");
      const stops = route.orderedStops ?? [];

      // Job stats: map jobId → set of stopStatusIds
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

      // Arrived stop: last status=3 in route sequence
      let arrivedStop: { jobId: number; stopId: number } | null = null;
      for (const stop of stops) {
        if (stop.stopStatusId === 3 && stop.jobId && stop.stopId) {
          arrivedStop = { jobId: stop.jobId, stopId: stop.stopId };
        }
      }

      result[driverId] = { stats: { total, active, done: total - active }, arrivedStop };
    }
    return result;
  } catch {
    return {};
  }
}

// ── Main handler ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const env      = (req.nextUrl.searchParams.get("env")      ?? "prod")      as Env;
  const provider =  req.nextUrl.searchParams.get("provider") ?? "haversine";

  const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const today = vnNow.toISOString().split("T")[0];

  // Fetch drivers + jobs in parallel
  const [allDrivers, jobsRes] = await Promise.all([
    getDrivers(env),
    getUnassignedJobs(1, 50, env),
  ]);

  const drivers = allDrivers.filter((d) => d.latitude != null && d.longitude != null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobs = ((jobsRes.data ?? []) as any[])
    .filter((j) => { const ts = j.scheduled_delivery_ts ?? null; return !ts || ts.startsWith(today); })
    .sort((a, b) => (a.create_ts ?? "").localeCompare(b.create_ts ?? ""));

  // Compute haversine top-3 for each job (keep lat/lon for routing)
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

    const ranked = drivers
      .map((d) => ({
        driver_id:   d.delivery_driver_id,
        driver_name: d.last_name?.trim() || `${d.first_name} ${d.last_name}`.trim(),
        haversine_km: Math.round(haversineKm(pickupStop.latitude, pickupStop.longitude, d.latitude!, d.longitude!) * 10) / 10,
        status_id:   d.driver_status_id ?? 4,
        last_login_ts: d.last_login_ts ?? null,
        lat: d.latitude!,
        lon: d.longitude!,
      }))
      .sort((a, b) => a.haversine_km - b.haversine_km)
      .slice(0, TOP_N);

    intermediate.push({
      job_id: job.job_id,
      pickup: pickupStop.customer_name ?? pickupStop.customer_id ?? "—",
      unscheduled: !job.scheduled_delivery_ts,
      pickup_lat: pickupStop.latitude,
      pickup_lon: pickupStop.longitude,
      drivers: ranked,
    });
  }

  // Routing — all jobs in parallel
  type RouteResult = { distance_km: number; eta_mins: number } | null;
  const routingMap = new Map<string, RouteResult>();

  if (provider === "valhalla" && intermediate.length > 0) {
    const tasks = intermediate.flatMap((s) =>
      s.drivers.map((d) => ({
        key: `${s.job_id}:${d.driver_id}`,
        fromLat: s.pickup_lat, fromLon: s.pickup_lon,
        toLat: d.lat, toLon: d.lon,
      }))
    );
    const results = await Promise.all(
      tasks.map((t) => valhallaRoute(t.fromLat, t.fromLon, t.toLat, t.toLon))
    );
    tasks.forEach((t, i) => routingMap.set(t.key, results[i]));
  }

  if (provider === "goong" && intermediate.length > 0) {
    const perJobResults = await Promise.all(
      intermediate.map((s) =>
        goongMatrix(
          s.pickup_lat,
          s.pickup_lon,
          s.drivers.map((d) => ({ lat: d.lat, lon: d.lon }))
        )
      )
    );
    intermediate.forEach((s, si) => {
      s.drivers.forEach((d, di) => {
        routingMap.set(`${s.job_id}:${d.driver_id}`, perJobResults[si][di]);
      });
    });
  }

  // Fetch route data (job stats + arrived stops)
  const auth = process.env.CARTRACK_AUTH ?? "";
  const cookie = await getFleetwebCookie();
  const routeData: Record<string, DriverRouteData> = {};
  if (cookie) Object.assign(routeData, await fetchAllDriverRouteData(today, auth, cookie));

  // Resolve arrived stop coordinates via job details
  // Collect unique jobIds that have an arrived stop across all drivers in our top-3 lists
  const relevantDriverIds = new Set(intermediate.flatMap((s) => s.drivers.map((d) => d.driver_id)));
  const arrivedJobIds = new Set<number>();
  for (const driverId of relevantDriverIds) {
    const arrived = routeData[driverId]?.arrivedStop;
    if (arrived) arrivedJobIds.add(arrived.jobId);
  }

  // Fetch job details in parallel to get stop lat/lon
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobStopIndex = new Map<number, any[]>(); // jobId → stops array
  await Promise.all(
    [...arrivedJobIds].map(async (jobId) => {
      try {
        const detail = await (await import("@/lib/cartrack")).getJobDetails(jobId, env);
        const stops = detail?.data?.stops ?? [];
        if (stops.length) jobStopIndex.set(jobId, stops);
      } catch { /* skip on error */ }
    })
  );

  // Build driverId → arrived stop {lat, lon}
  const arrivedLocations = new Map<string, { lat: number; lon: number }>();
  for (const driverId of relevantDriverIds) {
    const arrived = routeData[driverId]?.arrivedStop;
    if (!arrived) continue;
    const stops = jobStopIndex.get(arrived.jobId) ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stop = stops.find((s: any) => s.stop_id === arrived.stopId);
    if (stop?.latitude && stop?.longitude) {
      arrivedLocations.set(driverId, { lat: stop.latitude, lon: stop.longitude });
    }
  }

  // Compute arrived_stop → pickup routing (parallel, same provider)
  const arrivedRoutingMap = new Map<string, RouteResult>(); // key: `${job_id}:${driver_id}`

  if (arrivedLocations.size > 0 && intermediate.length > 0) {
    if (provider === "valhalla") {
      const tasks = intermediate.flatMap((s) =>
        s.drivers
          .filter((d) => arrivedLocations.has(d.driver_id))
          .map((d) => {
            const loc = arrivedLocations.get(d.driver_id)!;
            return { key: `${s.job_id}:${d.driver_id}`, fromLat: loc.lat, fromLon: loc.lon, toLat: s.pickup_lat, toLon: s.pickup_lon };
          })
      );
      const results = await Promise.all(tasks.map((t) => valhallaRoute(t.fromLat, t.fromLon, t.toLat, t.toLon)));
      tasks.forEach((t, i) => arrivedRoutingMap.set(t.key, results[i]));

    } else if (provider === "goong") {
      // Group by driver: one Goong call per driver (arrived as origin, relevant pickups as destinations)
      const byDriver = new Map<string, { jobId: number; pickupLat: number; pickupLon: number }[]>();
      for (const s of intermediate) {
        for (const d of s.drivers) {
          if (!arrivedLocations.has(d.driver_id)) continue;
          if (!byDriver.has(d.driver_id)) byDriver.set(d.driver_id, []);
          byDriver.get(d.driver_id)!.push({ jobId: s.job_id, pickupLat: s.pickup_lat, pickupLon: s.pickup_lon });
        }
      }
      await Promise.all(
        [...byDriver.entries()].map(async ([driverId, pickups]) => {
          const loc = arrivedLocations.get(driverId)!;
          const results = await goongMatrix(loc.lat, loc.lon, pickups.map((p) => ({ lat: p.pickupLat, lon: p.pickupLon })));
          pickups.forEach((p, i) => arrivedRoutingMap.set(`${p.jobId}:${driverId}`, results[i]));
        })
      );

    } else {
      // Haversine fallback — no extra network call needed, computed inline below
    }
  }

  // Assemble final response (strip internal lat/lon)
  const suggestions = intermediate.map((s) => ({
    job_id: s.job_id,
    pickup: s.pickup,
    unscheduled: s.unscheduled,
    drivers: s.drivers.map((d) => {
      const routing = routingMap.get(`${s.job_id}:${d.driver_id}`) ?? null;
      const arrivedLoc = arrivedLocations.get(d.driver_id) ?? null;

      // Arrived → pickup straight-line (always available when arrived location is known)
      const arrivedHaversineKm = arrivedLoc
        ? Math.round(haversineKm(arrivedLoc.lat, arrivedLoc.lon, s.pickup_lat, s.pickup_lon) * 10) / 10
        : null;

      // Arrived → pickup road routing (valhalla/goong); for haversine provider use straight-line only
      const arrivedRouting = arrivedRoutingMap.get(`${s.job_id}:${d.driver_id}`) ?? null;

      return {
        driver_id:    d.driver_id,
        driver_name:  d.driver_name,
        haversine_km: d.haversine_km,
        distance_km:  routing?.distance_km ?? null,
        eta_mins:     routing?.eta_mins    ?? null,
        status_id:    d.status_id,
        last_login_ts: d.last_login_ts,
        jobs_total:  routeData[d.driver_id]?.stats.total  ?? null,
        jobs_active: routeData[d.driver_id]?.stats.active ?? null,
        jobs_done:   routeData[d.driver_id]?.stats.done   ?? null,
        // Detour leg: arrived stop → pickup (null if driver has no status=3 stop or location unknown)
        arrived_haversine_km: arrivedHaversineKm,
        arrived_distance_km:  arrivedRouting?.distance_km ?? null,
        arrived_eta_mins:     arrivedRouting?.eta_mins    ?? null,
      };
    }),
  }));

  return NextResponse.json({ suggestions, unmatched, drivers_with_gps: drivers.length, provider });
}
