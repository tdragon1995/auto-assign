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
  active: number;
  done: number;
}

export type DetourLabel = "Arrived" | "En Route" | "Last Completed";

interface DriverRouteData {
  stats: DriverJobStats;
  // Best reference stop for detour estimation.
  // Priority: Arrived (status=3) → En Route (status=2) → Last Completed (status=4, last in sequence)
  // Coordinates come directly from delivery_timeline_route_list — no secondary fetch needed.
  referenceStop: { lat: number; lon: number; label: DetourLabel } | null;
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
      orderedStops?: { jobId: number; stopId: number; stopStatusId: number; latitude: number; longitude: number }[];
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

      // Reference stop — scan once, last-in-sequence wins per tier
      // Arrived (3) > En Route (2) > Last Completed (4)
      let arrived:       { lat: number; lon: number } | null = null;
      let enRoute:       { lat: number; lon: number } | null = null;
      let lastCompleted: { lat: number; lon: number } | null = null;

      for (const stop of stops) {
        if (!stop.latitude || !stop.longitude) continue;
        const loc = { lat: stop.latitude, lon: stop.longitude };
        if (stop.stopStatusId === 3) arrived       = loc;
        if (stop.stopStatusId === 2) enRoute       = loc;
        if (stop.stopStatusId === 4) lastCompleted = loc;
      }

      const referenceStop =
        arrived       ? { ...arrived,       label: "Arrived"        as DetourLabel } :
        enRoute       ? { ...enRoute,       label: "En Route"       as DetourLabel } :
        lastCompleted ? { ...lastCompleted, label: "Last Completed" as DetourLabel } :
        null;

      result[driverId] = { stats: { total, active, done: total - active }, referenceStop };
    }
    return result;
  } catch {
    return {};
  }
}

// ── Main handler ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const env      = (req.nextUrl.searchParams.get("env")      ?? "prod") as Env;
  const provider =  req.nextUrl.searchParams.get("provider") ?? "haversine";

  const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const today = vnNow.toISOString().split("T")[0];

  const auth   = process.env.CARTRACK_AUTH ?? "";
  const cookie = await getFleetwebCookie();

  // Fetch drivers, jobs, and route data all in parallel
  const [allDrivers, jobsRes, routeData] = await Promise.all([
    getDrivers(env),
    getUnassignedJobs(1, 50, env),
    cookie
      ? fetchAllDriverRouteData(today, auth, cookie)
      : Promise.resolve({} as Record<string, DriverRouteData>),
  ]);

  // Only suggest Online (1) and On Route (2) drivers
  const EXCLUDED_DRIVER_STATUSES = new Set([3, 4, 5]);
  const drivers = allDrivers.filter(
    (d) => d.latitude != null && d.longitude != null && !EXCLUDED_DRIVER_STATUSES.has(d.driver_status_id ?? 4)
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobs = ((jobsRes.data ?? []) as any[])
    .filter((j) => { const ts = j.scheduled_delivery_ts ?? null; return !ts || ts.startsWith(today); })
    .sort((a, b) => (a.create_ts ?? "").localeCompare(b.create_ts ?? ""));

  // Status rank for sort: Online (1) → 0, On Route (2) → 1
  const statusRank = (s: number) => s === 1 ? 0 : 1;

  // Compute haversine top-3 for each job
  // Sort: haversine ASC → status rank ASC → jobs_done ASC (fairness) → last_login_ts DESC
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
        driver_id:    d.delivery_driver_id,
        driver_name:  d.last_name?.trim() || `${d.first_name} ${d.last_name}`.trim(),
        haversine_km: Math.round(haversineKm(pickupStop.latitude, pickupStop.longitude, d.latitude!, d.longitude!) * 10) / 10,
        status_id:    d.driver_status_id ?? 4,
        last_login_ts: d.last_login_ts ?? null,
        lat: d.latitude!,
        lon: d.longitude!,
      }))
      .sort((a, b) => {
        if (a.haversine_km !== b.haversine_km) return a.haversine_km - b.haversine_km;
        if (a.status_id !== b.status_id) return statusRank(a.status_id) - statusRank(b.status_id);
        const aDone = routeData[a.driver_id]?.stats.done ?? 0;
        const bDone = routeData[b.driver_id]?.stats.done ?? 0;
        if (aDone !== bDone) return aDone - bDone; // fewer completed = more fair
        const aTs = a.last_login_ts ?? "";
        const bTs = b.last_login_ts ?? "";
        return bTs.localeCompare(aTs); // more recent last seen wins
      })
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

  // ── Phase 1: GPS → Pickup routing ─────────────────────────────────────────
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
    const results = await Promise.all(tasks.map((t) => valhallaRoute(t.fromLat, t.fromLon, t.toLat, t.toLon)));
    tasks.forEach((t, i) => routingMap.set(t.key, results[i]));
  }

  if (provider === "goong" && intermediate.length > 0) {
    const perJobResults = await Promise.all(
      intermediate.map((s) =>
        goongMatrix(s.pickup_lat, s.pickup_lon, s.drivers.map((d) => ({ lat: d.lat, lon: d.lon })))
      )
    );
    intermediate.forEach((s, si) => {
      s.drivers.forEach((d, di) => {
        routingMap.set(`${s.job_id}:${d.driver_id}`, perJobResults[si][di]);
      });
    });
  }

  // ── Phase 2: Reference stop → Pickup routing ───────────────────────────────
  // For each driver in any top-3, use their referenceStop (Arrived / En Route / Last Completed)
  // as origin and compute detour distance to each job's pickup.
  // Group by unique origin coordinate to deduplicate drivers at the same location.
  const detourRoutingMap = new Map<string, RouteResult>(); // key: `${job_id}:${driver_id}`

  const relevantDriverIds = new Set(intermediate.flatMap((s) => s.drivers.map((d) => d.driver_id)));

  // Build: originKey (`lat,lon`) → list of { driverIds[], pickups[] }
  // so drivers at the same location share one Goong/Valhalla call
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
    if (provider === "valhalla") {
      // One call per unique origin × pickup pair (deduplicated by origin coordinate)
      const tasks: { key: string; fromLat: number; fromLon: number; toLat: number; toLon: number; jobId: number; driverIds: string[] }[] = [];
      for (const [originKey, driverIds] of originToDrivers) {
        const from = originCoords.get(originKey)!;
        for (const s of intermediate) {
          tasks.push({ key: `${originKey}:${s.job_id}`, fromLat: from.lat, fromLon: from.lon, toLat: s.pickup_lat, toLon: s.pickup_lon, jobId: s.job_id, driverIds });
        }
      }
      const results = await Promise.all(tasks.map((t) => valhallaRoute(t.fromLat, t.fromLon, t.toLat, t.toLon)));
      tasks.forEach((t, i) => {
        for (const driverId of t.driverIds) {
          detourRoutingMap.set(`${t.jobId}:${driverId}`, results[i]);
        }
      });

    } else if (provider === "goong") {
      // One Goong call per unique origin, all pickups as destinations
      await Promise.all(
        [...originToDrivers.entries()].map(async ([originKey, driverIds]) => {
          const from = originCoords.get(originKey)!;
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
    // Haversine: computed inline in assembly below — no extra calls needed
  }

  // ── Assemble response ──────────────────────────────────────────────────────
  const suggestions = intermediate.map((s) => ({
    job_id: s.job_id,
    pickup: s.pickup,
    unscheduled: s.unscheduled,
    drivers: s.drivers.map((d) => {
      const routing    = routingMap.get(`${s.job_id}:${d.driver_id}`) ?? null;
      const ref        = routeData[d.driver_id]?.referenceStop ?? null;
      const usesRouting = provider === "valhalla" || provider === "goong";

      const detourHaversineKm = ref
        ? Math.round(haversineKm(ref.lat, ref.lon, s.pickup_lat, s.pickup_lon) * 10) / 10
        : null;
      const detourRouting = usesRouting ? (detourRoutingMap.get(`${s.job_id}:${d.driver_id}`) ?? null) : null;

      return {
        driver_id:     d.driver_id,
        driver_name:   d.driver_name,
        haversine_km:  d.haversine_km,
        distance_km:   routing?.distance_km ?? null,
        eta_mins:      routing?.eta_mins    ?? null,
        status_id:     d.status_id,
        last_login_ts: d.last_login_ts,
        jobs_total:    routeData[d.driver_id]?.stats.total  ?? null,
        jobs_active:   routeData[d.driver_id]?.stats.active ?? null,
        jobs_done:     routeData[d.driver_id]?.stats.done   ?? null,
        // Detour: reference stop → pickup
        detour_label:        ref?.label ?? null,
        detour_haversine_km: detourHaversineKm,
        detour_distance_km:  detourRouting?.distance_km ?? null,
        detour_eta_mins:     detourRouting?.eta_mins    ?? null,
      };
    }),
  }));

  return NextResponse.json({ suggestions, unmatched, drivers_with_gps: drivers.length, provider });
}
