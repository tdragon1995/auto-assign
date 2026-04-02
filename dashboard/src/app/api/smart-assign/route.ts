import { NextRequest, NextResponse } from "next/server";
import { getDrivers, getUnassignedJobs, type Env } from "@/lib/cartrack";

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

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  // Fetch drivers and unassigned jobs in parallel
  const [allDrivers, jobsRes] = await Promise.all([
    getDrivers(env),
    getUnassignedJobs(1, 50, env),
  ]);

  // Only keep drivers with valid GPS
  const drivers = allDrivers.filter(
    (d) => d.latitude != null && d.longitude != null
  );

  // Today's date range in Vietnam time (UTC+7)
  const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const today = vnNow.toISOString().split("T")[0]; // YYYY-MM-DD

  // Keep today's jobs + jobs with no scheduled date (include gracefully)
  const allJobs = jobsRes.data ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobs = (allJobs as any[])
    .filter((j) => {
      const ts: string | null = j.scheduled_delivery_ts ?? null;
      if (!ts) return true; // null schedule — include gracefully
      return ts.startsWith(today);
    })
    .sort((a, b) => (a.create_ts ?? "").localeCompare(b.create_ts ?? ""));

  const assigned: {
    job_id: number;
    driver_id: string;
    driver_name: string;
    pickup: string;
    distance_km: number;
    unscheduled: boolean;
  }[] = [];

  const unmatched: { job_id: number; reason: string }[] = [];

  // Driver pool — remove each driver once assigned
  const pool = [...drivers];

  for (const job of jobs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickupStop = (job.stops as any[])?.find((s: any) => s.stop_type_id === 1);

    if (!pickupStop?.latitude || !pickupStop?.longitude) {
      unmatched.push({ job_id: job.job_id, reason: "No pickup GPS" });
      continue;
    }

    if (pool.length === 0) {
      unmatched.push({ job_id: job.job_id, reason: "No drivers left in pool" });
      continue;
    }

    // Find nearest driver
    let nearest = pool[0];
    let minDist = haversineKm(
      pickupStop.latitude,
      pickupStop.longitude,
      nearest.latitude!,
      nearest.longitude!
    );

    for (const driver of pool.slice(1)) {
      const dist = haversineKm(
        pickupStop.latitude,
        pickupStop.longitude,
        driver.latitude!,
        driver.longitude!
      );
      if (dist < minDist) {
        minDist = dist;
        nearest = driver;
      }
    }

    // Suggest (no write to Cartrack)
    assigned.push({
      job_id: job.job_id,
      driver_id: nearest.delivery_driver_id,
      driver_name: `${nearest.first_name} ${nearest.last_name}`.trim(),
      pickup: pickupStop.customer_name ?? pickupStop.customer_id ?? "—",
      unscheduled: !job.scheduled_delivery_ts,
      distance_km: Math.round(minDist * 10) / 10,
    });
    // Remove driver from pool so they aren't double-suggested
    pool.splice(pool.indexOf(nearest), 1);
  }

  return NextResponse.json({ assigned, unmatched, drivers_with_gps: drivers.length });
}
