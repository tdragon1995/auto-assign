import { Redis } from "@upstash/redis";
import { getTimelineJobs, type Env } from "./cartrack";
import type { Job, Stop } from "./types";

/**
 * Per-driver slices of the day's timeline, for the chấm-công screen.
 *
 * Why this exists: the driver check-in screen asked Cartrack for the WHOLE
 * network's timeline on every single load, then kept the one driver's rows —
 * ~250 full-network fetches per 12h, uncached, which is most of that route's
 * CPU and memory. This caches one Cartrack fetch per date into a hash with one
 * field PER DRIVER, so a driver's screen reads only their own rows.
 *
 * Same shape as the branch feed's cache (see api/location-jobs), deliberately:
 * one field per consumer keeps every read small. Storing the raw timeline as a
 * single value is NOT an option — it runs ~2 MB against Upstash's 1 MB cap, and
 * an oversized SET fails inside a swallowed catch.
 *
 * Safe to cache because `getTimelineJobs` is used only by display routes. The
 * assign engine reads routes via `getTimelineRoutes` and is untouched by this —
 * no assignment decision is ever made from a cached timeline.
 */

const CACHE_TTL_S = 90;

// Proves the day was built, so "this driver has no tasks today" is distinguishable
// from "nothing cached yet". Without it a driver with no tasks re-fetches the whole
// network on every poll — worse than no cache at all.
const BUILT_FIELD = "__built__";

function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/** Exactly the fields the chấm-công route reads — job labels/status/timestamps plus
 *  the stop fields `isStopStarted` and the location switcher need. Anything else
 *  (addresses, todos, POD images) is dropped: it is never rendered here and it is
 *  what makes the raw timeline too big to cache. */
function slimStop(s: Stop) {
  return {
    stop_id: s.stop_id,
    stop_type_id: s.stop_type_id,
    stop_status_id: s.stop_status_id ?? null,
    customer_id: s.customer_id,
    customer_name: s.customer_name ?? s.name ?? "",
    activity_started_ts: s.activity_started_ts ?? null,
    activity_arrived_ts: s.activity_arrived_ts ?? null,
    activity_completed_ts: s.activity_completed_ts ?? null,
  };
}

function slimJob(j: Job) {
  return {
    job_id: j.job_id,
    reference_number: j.reference_number,
    job_status_id: j.job_status_id,
    delivery_driver_id: j.delivery_driver_id ?? null,
    scheduled_delivery_ts: j.scheduled_delivery_ts ?? null,
    create_ts: j.create_ts ?? null,
    labels: j.labels ?? [],
    stops: (j.stops ?? []).map(slimStop),
  };
}

export type DriverJob = ReturnType<typeof slimJob>;

function parseSlice(raw: unknown): DriverJob[] {
  if (raw == null) return [];
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as DriverJob[]; } catch { return []; }
  }
  return raw as DriverJob[];
}

/**
 * Today's jobs for one driver, from the shared per-driver cache.
 *
 * Returns `null` when the timeline is unavailable (UAT, or no fleetweb cookie —
 * it fails silently), so the caller keeps its REST fallback. An empty array means
 * the day WAS fetched and this driver genuinely has nothing — a real answer, not
 * a failure, and the caller must not treat it as one.
 */
export async function getDriverJobsToday(
  driverId: string,
  date: string,
  env: Env,
): Promise<DriverJob[] | null> {
  const cacheKey = `driverjobs:v1:${env}:${date}`;
  const redis = getRedis();

  if (redis) {
    try {
      const hit = await redis.hmget<Record<string, unknown>>(cacheKey, BUILT_FIELD, driverId);
      if (hit && hit[BUILT_FIELD] != null) return parseSlice(hit[driverId]);
    } catch { /* fall through and rebuild */ }
  }

  let timeline: Job[] | null = null;
  try {
    timeline = await getTimelineJobs(date, env);
  } catch {
    return null; // caller falls back to REST
  }
  if (!timeline) return null;

  const byDriver: Record<string, DriverJob[]> = {};
  for (const j of timeline) {
    const id = j.delivery_driver_id;
    if (!id) continue; // unassigned jobs belong to no driver's screen
    (byDriver[id] ??= []).push(slimJob(j));
  }

  // Best-effort write; a failure just means the next load rebuilds. Transactional
  // so a concurrent load can't read a half-built hash and treat it as a miss.
  if (redis) {
    try {
      const fields: Record<string, string> = { [BUILT_FIELD]: String(Date.now()) };
      for (const [id, jobs] of Object.entries(byDriver)) fields[id] = JSON.stringify(jobs);
      const tx = redis.multi();
      tx.del(cacheKey);
      tx.hset(cacheKey, fields);
      tx.expire(cacheKey, CACHE_TTL_S);
      await tx.exec();
    } catch { /* cache write is best-effort */ }
  }

  return byDriver[driverId] ?? [];
}
