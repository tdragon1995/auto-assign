import { NextRequest, NextResponse } from "next/server";
import { getDrivers, getUnassignedJobs, getFleetwebCookie, type Env } from "@/lib/cartrack";

const JSONRPC_URL = "https://fleetweb-vn.cartrack.com/jsonrpc/index.php";
const TOP_N = 3;

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

// Fetch all driver routes in one call, return a map of driverId → unique job count
async function fetchAllDriverJobCounts(
  dateVn: string,
  auth: string,
  cookie: string
): Promise<Record<string, number>> {
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
    const routes: { routeId: string; orderedStops?: { jobId: number }[] }[] = data.result?.routes ?? [];

    const counts: Record<string, number> = {};
    for (const route of routes) {
      // routeId = "driver_{uuid}" — extract the uuid
      const driverId = route.routeId.replace(/^driver_/, "");
      const jobIds = new Set(route.orderedStops?.map((s) => s.jobId).filter(Boolean) ?? []);
      counts[driverId] = jobIds.size;
    }
    return counts;
  } catch {
    return {};
  }
}

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const today = vnNow.toISOString().split("T")[0];

  // Fetch drivers + unassigned jobs in parallel
  const [allDrivers, jobsRes] = await Promise.all([
    getDrivers(env),
    getUnassignedJobs(1, 50, env),
  ]);

  // Only drivers with valid GPS
  const drivers = allDrivers.filter((d) => d.latitude != null && d.longitude != null);

  // Filter jobs to today + unscheduled, oldest first
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobs = ((jobsRes.data ?? []) as any[])
    .filter((j) => {
      const ts: string | null = j.scheduled_delivery_ts ?? null;
      if (!ts) return true;
      return ts.startsWith(today);
    })
    .sort((a, b) => (a.create_ts ?? "").localeCompare(b.create_ts ?? ""));

  // For each job, find top-N nearest drivers
  const suggestions: {
    job_id: number;
    pickup: string;
    unscheduled: boolean;
    drivers: { driver_id: string; driver_name: string; distance_km: number; status_id: number; last_login_ts: string | null }[];
  }[] = [];

  const unmatchedJobs: { job_id: number; reason: string }[] = [];
  const driverIdSet = new Set<string>();

  for (const job of jobs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickupStop = (job.stops as any[])?.find((s: any) => s.stop_type_id === 1);

    if (!pickupStop?.latitude || !pickupStop?.longitude) {
      unmatchedJobs.push({ job_id: job.job_id, reason: "No pickup GPS" });
      continue;
    }

    // Sort all GPS-valid drivers by distance, take top N
    const ranked = drivers
      .map((d) => ({
        driver_id: d.delivery_driver_id,
        driver_name: d.last_name?.trim() || `${d.first_name} ${d.last_name}`.trim(),
        distance_km: Math.round(haversineKm(pickupStop.latitude, pickupStop.longitude, d.latitude!, d.longitude!) * 10) / 10,
        status_id: d.driver_status_id ?? 4,
        last_login_ts: d.last_login_ts ?? null,
      }))
      .sort((a, b) => a.distance_km - b.distance_km)
      .slice(0, TOP_N);

    ranked.forEach((d) => driverIdSet.add(d.driver_id));

    suggestions.push({
      job_id: job.job_id,
      pickup: pickupStop.customer_name ?? pickupStop.customer_id ?? "—",
      unscheduled: !job.scheduled_delivery_ts,
      drivers: ranked,
    });
  }

  // Fetch job counts for all unique driver IDs in parallel
  const auth = process.env.CARTRACK_AUTH ?? "";
  const cookie = await getFleetwebCookie();

  const jobCounts: Record<string, number | null> = {};
  if (cookie) {
    const counts = await fetchAllDriverJobCounts(today, auth, cookie);
    Object.assign(jobCounts, counts);
  }

  // Attach job counts to suggestions
  const result = suggestions.map((s) => ({
    ...s,
    drivers: s.drivers.map((d) => ({ ...d, job_count: jobCounts[d.driver_id] ?? null })),
  }));

  return NextResponse.json({
    suggestions: result,
    unmatched: unmatchedJobs,
    drivers_with_gps: drivers.length,
  });
}
