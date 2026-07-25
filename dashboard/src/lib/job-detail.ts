import { Redis } from "@upstash/redis";
import { getJobDetails, type Env } from "@/lib/cartrack";
import type { Job } from "@/lib/types";

/**
 * Job-sheet detail shared by every "expand a trip" screen (/qr, /psc-tinh — /ao has no
 * per-job todos/photos to show). One mapper so a fix to phone parsing or todo shape
 * lands everywhere at once instead of drifting between copies.
 */

// REST embeds the human name in driver.last_name (first_name is an internal code);
// timeline-derived jobs carry the route's driverFullname in first_name, prefixed with
// that internal code ("F - C - DC100320 Lý Chánh Hùng"). Take whichever is populated
// and strip the code prefix. The code is any two-letter series plus digits, not just
// DC — part-timers carry PT ("P - P - PT101408 Đào Thanh Bình").
const DRIVER_CODE_PREFIX = /^(?:[A-Z]{1,2}\s*-\s*)*[A-Z]{2}\d+\s+/;

export function driverDisplayName(driver: Job["driver"]): string | null {
  const raw = driver?.last_name?.trim() || driver?.first_name?.trim() || null;
  return raw ? raw.replace(DRIVER_CODE_PREFIX, "") : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function detailJob(j: any) {
  // Cartrack stores the mobile without its leading zero and the country code apart
  // ("84" + "931773106"); the page needs both a display form and a tel: form.
  const rawPhone: string = (j.driver?.phone_number ?? "").toString().replace(/\D/g, "");
  const phoneCode: string = (j.driver?.phone_code ?? "").toString().replace(/\D/g, "");
  return {
    job_id: j.job_id,
    reference_number: j.reference_number,
    job_status_id: j.job_status_id,
    scheduled_delivery_ts: j.scheduled_delivery_ts ?? null,
    last_assigned_plan_id: j.last_assigned_plan_id ?? null,
    driver: {
      last_name: driverDisplayName(j.driver),
      phone_local: rawPhone ? `0${rawPhone}` : null,
      phone_e164: rawPhone ? `+${phoneCode || "84"}${rawPhone}` : null,
    },
    // Batch IDs (Mã Batch) attached by the via-3PL flow or scanned by the driver.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    item_tracking_numbers: (j.items ?? []).map((it: any) => it.tracking_number).filter(Boolean),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stops: (j.stops ?? []).map((s: any) => ({
      stop_id: s.stop_id,
      stop_type_id: s.stop_type_id,
      stop_status_id: s.stop_status_id,
      customer_id: s.customer_id,
      customer_name: s.customer_name ?? s.name ?? "",
      address_line_1: s.address_line_1 ?? null,
      activity_started_ts: s.activity_started_ts ?? null,
      activity_arrived_ts: s.activity_arrived_ts ?? null,
      activity_completed_ts: s.activity_completed_ts ?? null,
      delivery_windows: (s.delivery_windows ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((w: any) => ({ time_from: w.time_from ?? null, time_to: w.time_to ?? null }))
        .filter((w: { time_from: string | null; time_to: string | null }) => w.time_from || w.time_to),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      todos: (s.todos ?? []).map((t: any) => ({
        todo_type_id: t.todo_type_id,
        description: t.description ?? null,
        note: t.note ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        images: (t.images ?? []).map((img: any) => ({
          image_id: img.image_id,
          image_url: img.image_url,
          is_deleted: img.is_deleted,
        })),
      })),
    })),
  };
}

export type JobDetail = ReturnType<typeof detailJob>;

function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/**
 * Fetch + cache one job's full detail. This call is the slow one — several seconds
 * against Cartrack — which is long enough that a job sheet visibly waits on it for POD
 * photos and the driver's phone. A finished job never changes again, so completed jobs
 * (status 5) cache for a day; anything still moving gets a 60s TTL so timestamps stay
 * current. `keyPrefix` namespaces the cache per caller (`qr`, `psctinh`, …) so two
 * pages fetching the same job_id — unlikely but not impossible — don't collide.
 */
export async function fetchJobDetail(
  jobId: number,
  env: Env,
  keyPrefix: string
): Promise<{ job: JobDetail; cached: boolean } | null> {
  const redis = getRedis();
  const detailKey = `jobdetail:${keyPrefix}:v1:${env}:${jobId}`;

  if (redis) {
    try {
      const hit = await redis.get<JobDetail>(detailKey);
      if (hit) return { job: hit, cached: true };
    } catch {}
  }

  const { data } = await getJobDetails(jobId, env);
  if (!data?.job_id) return null;
  const job = detailJob(data);

  if (redis) {
    const ttl = job.job_status_id === 5 ? 86_400 : 60;
    try { await redis.set(detailKey, job, { ex: ttl }); } catch {}
  }

  return { job, cached: false };
}
