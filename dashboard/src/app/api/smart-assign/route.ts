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

// ── Driver job counts (one call for all drivers) ───────────────────────────

interface DriverJobStats {
  total: number;
  active: number; // distinct jobs with any stop at status 1/2/3
  done: number;   // distinct jobs with all stops at status 4/5
}

const ACTIVE_STOP_STATUSES = new Set([1, 2, 3]);

async function fetchAllDriverJobCounts(
  dateVn: string,
  auth: string,
  cookie: string
): Promise<Record<string, DriverJobStats>> {
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
    const routes: { routeId: string; orderedStops?: { jobId: number; stopStatusId: number }[] }[] =
      data.result?.routes ?? [];
    const stats: Record<string, DriverJobStats> = {};
    for (const route of routes) {
      const driverId = route.routeId.replace(/^driver_/, "");
      // Map jobId → set of stopStatusIds seen for that job
      const jobStatuses = new Map<number, Set<number>>();
      for (const stop of route.orderedStops ?? []) {
        if (!stop.jobId) continue;
        if (!jobStatuses.has(stop.jobId)) jobStatuses.set(stop.jobId, new Set());
        jobStatuses.get(stop.jobId)!.add(stop.stopStatusId);
      }
      const total = jobStatuses.size;
      let active = 0;
      for (const statuses of jobStatuses.values()) {
        if ([...statuses].some((s) => ACTIVE_STOP_STATUSES.has(s))) active++;
      }
      stats[driverId] = { total, active, done: total - active };
    }
    return stats;
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

  // Fetch job counts
  const auth = process.env.CARTRACK_AUTH ?? "";
  const cookie = await getFleetwebCookie();
  const jobStats: Record<string, DriverJobStats> = {};
  if (cookie) Object.assign(jobStats, await fetchAllDriverJobCounts(today, auth, cookie));

  // Assemble final response (strip internal lat/lon)
  const suggestions = intermediate.map((s) => ({
    job_id: s.job_id,
    pickup: s.pickup,
    unscheduled: s.unscheduled,
    drivers: s.drivers.map((d) => {
      const routing = routingMap.get(`${s.job_id}:${d.driver_id}`) ?? null;
      return {
        driver_id:    d.driver_id,
        driver_name:  d.driver_name,
        haversine_km: d.haversine_km,
        distance_km:  routing?.distance_km ?? null,
        eta_mins:     routing?.eta_mins    ?? null,
        status_id:    d.status_id,
        last_login_ts: d.last_login_ts,
        jobs_total:  jobStats[d.driver_id]?.total  ?? null,
        jobs_active: jobStats[d.driver_id]?.active ?? null,
        jobs_done:   jobStats[d.driver_id]?.done   ?? null,
      };
    }),
  }));

  return NextResponse.json({ suggestions, unmatched, drivers_with_gps: drivers.length, provider });
}
