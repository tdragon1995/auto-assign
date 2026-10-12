import { BASE_URL, getHeaders, completeJob, type Env } from "./cartrack";
import { isCompletedOrRejectedStop, pscPairKey } from "./job-filters";
import { releaseCreateLock, unmarkPscPair } from "./smart-log-kv";
import { vnDate } from "./time";
import type { Stop } from "./types";

/**
 * Handing a trip to a ride-hailing courier (Grab/Be/XanhSM/Ahamove): the job goes
 * to the 3PL proxy driver — so every branch screen reads it as "Đã gửi qua đối tác"
 * and no Diag driver is credited or paid for it — with the courier's codes as item
 * tracking numbers, and is force-completed. Shared by the branch's /qr button and
 * the dispatcher's "Điều chỉnh job" panel, split in two so a caller can record
 * something between the check and the write.
 */

export const THREE_PL_DRIVER_ID = "6437bace-6578-11f1-9378-fa163ee8d8ac";

export interface HandoffItem {
  description: string;
  tracking_number: string;
}

type Fail = { ok: false; status: number; error: string; details?: unknown };
export interface HandoffJob {
  ok: true;
  jobId: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  pickup?: Stop;
  dropoff?: Stop;
}

/** The job must exist, not be over, and its pickup must not be done — a driver
 *  en route (2) or arrived (3) can still hand over to a courier. */
export async function check3plHandoff(jobId: number, env: Env): Promise<HandoffJob | Fail> {
  const res = await fetch(`${BASE_URL}/jobs/${jobId}`, { headers: getHeaders(env), cache: "no-store" });
  if (!res.ok) return { ok: false, status: 404, error: "Job not found" };
  const data = (await res.json()).data;
  const statusId: number | null = data?.job_status_id ?? null;
  if (statusId === 5) return { ok: false, status: 409, error: "Chuyến đã hoàn thành rồi" };
  if (statusId === 3 || statusId === 7) return { ok: false, status: 409, error: "Chuyến đã huỷ/thất bại" };
  const stops: Stop[] = data?.stops ?? [];
  const pickup = stops.find((s) => s.stop_type_id === 1);
  const dropoff = stops.find((s) => s.stop_type_id === 2);
  if (pickup && isCompletedOrRejectedStop(pickup.stop_status_id ?? 0)) {
    return { ok: false, status: 409, error: "Không thể gửi: tài xế đã hoàn thành lấy mẫu." };
  }
  return { ok: true, jobId, data, pickup, dropoff };
}

export async function complete3plHandoff(job: HandoffJob, items: HandoffItem[], env: Env): Promise<{ ok: true } | Fail> {
  // Assign the proxy driver + attach the codes as item tracking numbers (partial update).
  const updateRes = await fetch(`${BASE_URL}/jobs/${job.jobId}`, {
    method: "PUT",
    headers: getHeaders(env),
    body: JSON.stringify({
      delivery_driver_id: THREE_PL_DRIVER_ID,
      items: items.map((it) => ({ ...it, weight: 0, item_type_id: 1, quantity: 1 })),
    }),
  });
  if (!updateRes.ok) {
    return { ok: false, status: 502, error: "Gán tài xế / mã Batch thất bại", details: await updateRes.json().catch(() => ({})) };
  }

  const completeRes = await completeJob(job.jobId, env);
  if (!completeRes.ok) {
    return { ok: false, status: 502, error: "Hoàn thành chuyến thất bại", details: { status: completeRes.status, body: completeRes.body } };
  }

  // Pickup→dropoff is fulfilled — clear both dedup guards so a fresh batch can be
  // re-requested at once instead of colliding with the just-completed job. Awaited:
  // a lost note leaves the handed-off trip looking un-handed-off to the branch.
  const { pickup, dropoff } = job;
  if (pickup?.customer_id && dropoff?.customer_id) {
    await unmarkPscPair(vnDate(), pscPairKey(pickup.customer_id, dropoff.customer_id), job.jobId).catch(() => {});
    void releaseCreateLock(`psc:${pickup.customer_id}-${dropoff.customer_id}-${vnDate()}`);
  }
  return { ok: true };
}
