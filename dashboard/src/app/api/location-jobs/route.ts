import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { BASE_URL, getHeaders, getTimelineJobs, getUnroutedJobs, type Env } from "@/lib/cartrack";
import { driverDisplayName, fetchJobDetail } from "@/lib/job-detail";
import type { Job, Stop } from "@/lib/types";

export const runtime = "edge";
export const preferredRegion = "sin1";

// Shared day cache: the timeline fetch pulls the WHOLE network's day (~2 MB) and each
// QR tap keeps only one location's rows — so a burst of taps used to repeat the same
// download+parse per tap. One Cartrack fetch per date fills a Redis HASH with one field
// PER LOCATION; a branch tap then reads only its own slice. It used to read the whole
// network's day back out and filter it in-memory on every poll, and that unpacking was
// the bulk of this route's CPU (~1.6k reads/day of an all-locations blob). `?fresh=1`
// (the Làm mới button, post-cancel and post-3PL reloads) bypasses the read but still
// rewrites the hash, so a manual refresh updates it for everyone.
const CACHE_TTL_S = 90;

// Marker field written alongside the per-location fields. Without it a HGET miss is
// ambiguous — "this branch has no trips today" looks identical to "nothing cached yet",
// and a quiet branch would re-fetch the whole network on every single poll.
const BUILT_FIELD = "__built__";

function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// GET /api/location-jobs?date=2026-04-11&status=4&code=<customer_uuid>
//   Location-scoped list for the /qr page: only jobs touching `code`, slimmed to
//   the fields the list renders. The old whole-day dump was ~220 KB per tap and
//   the phone discarded 99% of it (all locations, todos, POD images).
// GET /api/location-jobs?job_id=123
//   Full detail for one job (address, todos, POD image URLs) — fetched only when
//   staff open the job sheet.
// Without `code`, returns the legacy whole-day dump so cached bundles keep working.

// Deliberately NOT carrying address_line_1: this shape is what goes into the shared
// day cache, and on 2026-07-25 (786 jobs / 1512 stops) the addresses alone were 111 KB
// of a 738 KB blob. Upstash caps a value at 1 MB, and an oversized SET fails inside a
// swallowed try/catch — which would silently turn every QR tap into its own 2.13 MB
// Cartrack fetch. Addresses come from the per-job detail call, which is Redis-cached.
// Windows are kept: 5 KB for the whole day, and only client pickups ever have one.
function slimStop(s: Stop) {
  return {
    stop_id: s.stop_id,
    stop_type_id: s.stop_type_id,
    stop_status_id: s.stop_status_id,
    customer_id: s.customer_id,
    customer_name: s.customer_name ?? s.name ?? "",
    activity_started_ts: s.activity_started_ts ?? null,
    activity_arrived_ts: s.activity_arrived_ts ?? null,
    activity_completed_ts: s.activity_completed_ts ?? null,
    delivery_windows: (s.delivery_windows ?? [])
      .map((w) => ({ time_from: w.time_from ?? null, time_to: w.time_to ?? null }))
      .filter((w) => w.time_from || w.time_to),
  };
}

function slimJob(j: Job) {
  return {
    job_id: j.job_id,
    reference_number: j.reference_number,
    job_status_id: j.job_status_id,
    scheduled_delivery_ts: j.scheduled_delivery_ts ?? null,
    // Plan-slot jobs regenerate daily and clutter the branch feed; the /qr page hides
    // the non-completed ones, so the id has to survive the slimming.
    last_assigned_plan_id: j.last_assigned_plan_id ?? null,
    item_tracking_numbers: j.item_tracking_numbers ?? [],
    driver: { last_name: driverDisplayName(j.driver) },
    stops: (j.stops ?? []).map(slimStop),
    // Only ever set on jobs from the unrouted pool.
    rejected_ts: null as string | null,
    rejected_reason: null as string | null,
  };
}

type SlimJob = ReturnType<typeof slimJob>;

/** Map a delivery_jobs_list_new row (camelCase, no driver by definition) into the same
 *  shape the feed already renders, so unassigned and rejected trips sit in the list
 *  beside the routed ones instead of being invisible. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function slimUnroutedJob(j: any): SlimJob {
  const t19 = (s: unknown): string | null =>
    typeof s === "string" && s.length >= 19 ? s.slice(0, 19).replace("T", " ") : null;
  return {
    job_id: j.jobId,
    reference_number: j.referenceNumber,
    job_status_id: j.jobStatusId,
    scheduled_delivery_ts: t19(j.scheduledTs),
    last_assigned_plan_id: null,
    item_tracking_numbers: [],
    driver: { last_name: null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stops: (j.stops ?? []).map((s: any) => ({
      stop_id: s.stopId,
      stop_type_id: s.stopTypeId,
      stop_status_id: s.stopStatusId,
      customer_id: s.customerId,
      customer_name: s.customerName ?? "",
      activity_started_ts: null,
      activity_arrived_ts: null,
      activity_completed_ts: null,
      delivery_windows: (s.deliveryWindows ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((w: any) => ({ time_from: w?.timeFrom ?? null, time_to: w?.timeTo ?? null }))
        .filter((w: { time_from: string | null; time_to: string | null }) => w.time_from || w.time_to),
    })),
    rejected_ts: t19(j.rejectedTs),
    rejected_reason: j.rejectedReason ?? null,
  };
}

/** Bucket jobs by every location their stops touch. A trip picking up at A and dropping
 *  at B lands in BOTH buckets — either branch's feed should show it, which is exactly
 *  what the old `stops.some(...)` filter did. Storing a job twice is deliberate: storage
 *  is the resource with headroom to spare (867 KB of 256 MB), and the duplication is what
 *  buys every read a small slice instead of the whole network's day. */
function groupByLocation(all: SlimJob[]): Record<string, SlimJob[]> {
  const byLoc: Record<string, SlimJob[]> = {};
  for (const j of all) {
    const seen = new Set<string>();
    for (const s of j.stops) {
      const id = s.customer_id;
      // A job that both picks up AND drops off at one location appears once for it.
      if (!id || seen.has(id)) continue;
      seen.add(id);
      (byLoc[id] ??= []).push(j);
    }
  }
  return byLoc;
}

/** A hash field that exists but holds no trips reads back as an empty list, not a miss —
 *  the caller has already confirmed the day was built via {@link BUILT_FIELD}. */
function parseSlice(raw: unknown): SlimJob[] {
  if (raw == null) return [];
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as SlimJob[]; } catch { return []; }
  }
  return raw as SlimJob[];
}

// `status=all` returns everything the feed shows in one call: assigned + completed from
// the route timeline, plus unassigned (2) and rejected (3) from the unrouted pool. The
// timeline alone only ever contains 4 and 5, so without the second source a branch never
// sees a request that hasn't been picked up or one a driver turned down.
const ALL_STATUSES = [2, 3, 4, 5];
const UNROUTED_STATUSES = [2, 3];
function matchesStatus(jobStatusId: number | undefined, status: string): boolean {
  if (status === "all") return ALL_STATUSES.includes(jobStatusId ?? 0);
  return jobStatusId === Number(status);
}

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  // ── ?job_id=123: full detail for the job sheet ─────────────────────────────
  const jobIdParam = req.nextUrl.searchParams.get("job_id");
  if (jobIdParam) {
    try {
      const result = await fetchJobDetail(Number(jobIdParam), env, "qr");
      if (!result) return NextResponse.json({ error: "Job not found" }, { status: 404 });
      return NextResponse.json(result.cached ? { job: result.job, cached: true } : { job: result.job });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }
  }

  const date = req.nextUrl.searchParams.get("date");
  const status = req.nextUrl.searchParams.get("status");
  const code = req.nextUrl.searchParams.get("code");

  if (!date || !status) {
    return NextResponse.json({ error: "Missing date or status" }, { status: 400 });
  }

  try {
    // Fast path (prod, code-scoped): one timeline JSON-RPC call covers assigned +
    // completed jobs; slim them and bucket by location before responding. The
    // buckets are shared via Redis for CACHE_TTL_S, so a burst of taps costs one
    // Cartrack fetch and each tap reads only its own branch. Any failure
    // (including a throw) falls back to REST rather than 500ing.
    if (code) {
      const fresh = req.nextUrl.searchParams.get("fresh") === "1";
      const cacheKey = `locjobs:v3:${env}:${date}`;
      const redis = getRedis();

      // One command, and it returns only this branch's trips plus the built-marker —
      // where the old shape handed back every location's day to filter down to one.
      let mine: SlimJob[] | null = null;
      if (redis && !fresh) {
        try {
          const hit = await redis.hmget<Record<string, unknown>>(cacheKey, BUILT_FIELD, code);
          if (hit && hit[BUILT_FIELD] != null) mine = parseSlice(hit[code]);
        } catch {
          mine = null;
        }
      }
      if (!mine) {
        // Two sources, fetched together: the route timeline (assigned + completed) and
        // the unrouted pool (unassigned + rejected). Neither covers the other.
        let timeline: Job[] | null = null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let unrouted: any[] | null = null;
        try {
          [timeline, unrouted] = await Promise.all([
            getTimelineJobs(date, env).catch(() => null),
            getUnroutedJobs(date, env).catch(() => null),
          ]);
        } catch {
          timeline = null;
        }
        if (timeline) {
          const all = [
            ...timeline.map(slimJob),
            ...(unrouted ?? []).filter((j) => UNROUTED_STATUSES.includes(j?.jobStatusId)).map(slimUnroutedJob),
          ];
          const byLoc = groupByLocation(all);
          mine = byLoc[code] ?? [];
          // Best-effort write — a failed rebuild just means the next tap fetches
          // again; never let caching break the response. DEL first so a location
          // that had trips earlier and has none now doesn't keep a stale field,
          // and as a transaction so a concurrent reader never sees a half-built
          // hash (which it would read as a miss and re-fetch the whole network).
          if (redis) {
            try {
              const fields: Record<string, string> = { [BUILT_FIELD]: String(Date.now()) };
              for (const [loc, jobs] of Object.entries(byLoc)) fields[loc] = JSON.stringify(jobs);
              const tx = redis.multi();
              tx.del(cacheKey);
              tx.hset(cacheKey, fields);
              tx.expire(cacheKey, CACHE_TTL_S);
              await tx.exec();
            } catch {}
          }
        }
      }
      if (mine) {
        // Location is already applied by the slice; only the status filter is left.
        const jobs = mine.filter((j) => matchesStatus(j.job_status_id, status));
        return NextResponse.json({ jobs });
      }
    }

    const headers = getHeaders(env);
    // `status=all` has no single REST equivalent — drop the filter and narrow below.
    const statusFilter = status === "all" ? "" : `&filter[job_status_id]=${status}`;
    const res = await fetch(
      `${BASE_URL}/jobs?filter[scheduled_delivery_ts_from]=${date} 00:00:00&filter[scheduled_delivery_ts_to]=${date} 23:59:59${statusFilter}&limit=1000`,
      { headers, cache: "no-store" }
    );
    if (!res.ok) return NextResponse.json({ jobs: [] });
    const data = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allJobs: any[] = data.data ?? [];

    // Code-scoped REST fallback: same filter + slim as the fast path.
    if (code) {
      const jobs = allJobs
        .filter((j) => matchesStatus(j.job_status_id, status))
        .filter((j) => (j.stops ?? []).some((s: Stop) => s.customer_id === code))
        .map(slimJob);
      return NextResponse.json({ jobs });
    }

    return NextResponse.json({ jobs: allJobs });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
