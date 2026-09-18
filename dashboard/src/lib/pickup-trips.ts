import { BASE_URL, deleteJob, getHeaders, type Env } from "./cartrack";
import { isStopStarted } from "./job-filters";
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

/**
 * Cancel a trip a request page booked, while its pickup is untouched. Re-reads the job
 * live — the list the button sat on can be minutes old — and refuses anything the page
 * did not book (`isOwn`), so a trip created in Labcenter or by dispatch can never be
 * removed from a client screen.
 */
export async function cancelOwnTrip(
  jobId: number, env: Env, isOwn: (job: { reference_number?: string | null; labels?: unknown }) => boolean,
): Promise<{ ok: true; pickupId: string; dropoffId: string } | { ok: false; status: number; error: string }> {
  const res = await fetch(`${BASE_URL}/jobs/${jobId}`, { headers: getHeaders(env), cache: "no-store" });
  if (!res.ok) return { ok: false, status: 404, error: "Không tìm thấy chuyến" };
  const job = (await res.json())?.data;
  if (!job || !isOwn(job)) return { ok: false, status: 403, error: "Không thể huỷ chuyến này" };
  if ([3, 5, 7].includes(job.job_status_id)) return { ok: false, status: 409, error: "Chuyến đã kết thúc" };
  const stops: { stop_type_id?: number; customer_id?: string; stop_status_id?: number | null; activity_started_ts?: string | null; activity_arrived_ts?: string | null; activity_completed_ts?: string | null }[] = job.stops ?? [];
  const pickup = stops.find((s) => s.stop_type_id === 1);
  if (pickup && isStopStarted(pickup)) {
    return { ok: false, status: 409, error: "Không thể huỷ: Giao Nhận Mẫu đã bắt đầu công việc." };
  }
  if (!(await deleteJob(jobId, env))) return { ok: false, status: 502, error: "Huỷ thất bại, vui lòng thử lại" };
  return {
    ok: true,
    pickupId: pickup?.customer_id ?? "",
    dropoffId: stops.find((s) => s.stop_type_id === 2)?.customer_id ?? "",
  };
}
