import type { Env } from "./cartrack";
import { locationJobs } from "./day-snapshot";
import { proxyKind } from "./proxy-drivers";
import { vnDate } from "./time";

/** One trip as the client request pages (/ndtp, /corp) list it. */
export interface PickupTrip {
  job_id: number;
  pickup_name: string;
  dropoff_name: string;
  job_status_id: number | null;
  pickup_status_id: number | null;
  dropoff_status_id: number | null;
  driver_name: string | null;
  parked: boolean;
  requested_ts: string | null;
  pickup_completed_ts: string | null;
  dropoff_started_ts: string | null;
  dropoff_completed_ts: string | null;
}

/**
 * Today's trips picked up at any of `pickupIds` and carrying `label` — i.e. the trips a
 * request page booked itself. Reads the day the assign cron already publishes (same
 * source as the /qr feeds), so a load normally costs a Redis read per pickup and no
 * Cartrack call; up to ~5 minutes behind. null = the day is unavailable.
 */
export async function pickupTripsToday(env: Env, pickupIds: readonly string[], label: string): Promise<PickupTrip[] | null> {
  const slices = await Promise.all(pickupIds.map((id) => locationJobs(vnDate(), env, id).catch(() => null)));
  if (slices.some((s) => s == null)) return null;

  const ids = new Set(pickupIds);
  const seen = new Set<number>();
  const trips: PickupTrip[] = [];
  for (const j of slices.flatMap((s) => s!)) {
    if (seen.has(j.job_id)) continue;
    seen.add(j.job_id);
    if (!j.labels.includes(label)) continue;
    // Cancelled and rejected trips are dispatch's business.
    if (![2, 4, 5].includes(j.job_status_id ?? 0)) continue;
    const pickup = j.stops.find((s) => s.stop_type_id === 1 && ids.has(s.customer_id ?? ""));
    if (!pickup) continue; // a trip only DELIVERING here
    const dropoff = j.stops.find((s) => s.stop_type_id === 2);
    const kind = proxyKind(j.driver.last_name, j.delivery_driver_id);
    trips.push({
      job_id: j.job_id,
      pickup_name: pickup.customer_name,
      dropoff_name: dropoff?.customer_name ?? "—",
      job_status_id: j.job_status_id ?? null,
      pickup_status_id: pickup.stop_status_id ?? null,
      dropoff_status_id: dropoff?.stop_status_id ?? null,
      driver_name: kind ? null : j.driver.last_name,
      parked: kind === "queue" || kind === "reject",
      // The unrouted pool writes "T", the timeline a space; one shape sorts and slices.
      requested_ts: j.scheduled_delivery_ts?.replace("T", " ").slice(0, 19) ?? null,
      pickup_completed_ts: pickup.activity_completed_ts,
      dropoff_started_ts: dropoff?.activity_started_ts ?? null,
      dropoff_completed_ts: dropoff?.activity_completed_ts ?? null,
    });
  }
  trips.sort((a, b) => (b.requested_ts ?? "").localeCompare(a.requested_ts ?? ""));
  return trips;
}
