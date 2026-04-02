import { NextRequest, NextResponse } from "next/server";
import { getDrivers, getUnassignedJobs, assignJob, type Env } from "@/lib/cartrack";

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

  // Sort jobs oldest-first so longer-waiting jobs get priority
  const jobs = (jobsRes.data ?? []).sort((a, b) =>
    (a.create_ts ?? "").localeCompare(b.create_ts ?? "")
  );

  const assigned: {
    job_id: number;
    driver_id: string;
    driver_name: string;
    pickup: string;
    distance_km: number;
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

    // Assign
    const result = await assignJob(
      nearest.delivery_driver_id,
      job.job_id,
      `${nearest.first_name} ${nearest.last_name}`.trim() || undefined,
      env
    );

    if (result.status === 200) {
      assigned.push({
        job_id: job.job_id,
        driver_id: nearest.delivery_driver_id,
        driver_name: `${nearest.first_name} ${nearest.last_name}`.trim(),
        pickup: pickupStop.customer_name ?? pickupStop.customer_id,
        distance_km: Math.round(minDist * 10) / 10,
      });
      // Remove driver from pool
      pool.splice(pool.indexOf(nearest), 1);
    } else {
      unmatched.push({ job_id: job.job_id, reason: `Assign API returned ${result.status}` });
    }
  }

  return NextResponse.json({ assigned, unmatched, drivers_with_gps: drivers.length });
}
