import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { BASE_URL, getHeaders, getTimelineJobs, type Env } from "@/lib/cartrack";
import { driverDisplayName, fetchJobDetail } from "@/lib/job-detail";
import type { Job, Stop } from "@/lib/types";

export const runtime = "edge";
export const preferredRegion = "sin1";

// Shared day cache: the timeline fetch pulls the WHOLE network's day (~2 MB)
// and each QR tap keeps only one location's rows — so a burst of taps used to
// repeat the same download+parse per tap. Cache the slimmed all-locations list
// once per date; every tap within the TTL filters it in-memory. `?fresh=1`
// (the Làm mới button, post-cancel and post-3PL reloads) bypasses the read but
// still rewrites the cache, so a manual refresh updates it for everyone.
const CACHE_TTL_S = 90;

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
  };
}

type SlimJob = ReturnType<typeof slimJob>;

// `status=all` returns assigned + completed in one call — the /qr feed shows both
// together, and two calls would mean two passes over the same cached day.
const ALL_STATUSES = [4, 5];
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
    // completed jobs; filter to this location and slim before responding. The
    // slimmed all-locations list is shared via Redis for CACHE_TTL_S so a burst
    // of taps costs one Cartrack fetch. Any failure (including a throw) falls
    // back to REST rather than 500ing.
    if (code) {
      const fresh = req.nextUrl.searchParams.get("fresh") === "1";
      const cacheKey = `locjobs:v1:${env}:${date}`;
      const redis = getRedis();

      let slim: SlimJob[] | null = null;
      if (redis && !fresh) {
        try {
          slim = await redis.get<SlimJob[]>(cacheKey);
        } catch {
          slim = null;
        }
      }
      if (!slim) {
        let timeline: Job[] | null = null;
        try {
          timeline = await getTimelineJobs(date, env);
        } catch {
          timeline = null;
        }
        if (timeline) {
          slim = timeline.map(slimJob);
          // Best-effort write — an oversized or failed SET just means the next
          // tap fetches again; never let caching break the response.
          if (redis) {
            try {
              await redis.set(cacheKey, slim, { ex: CACHE_TTL_S });
            } catch {}
          }
        }
      }
      if (slim) {
        const jobs = slim.filter(
          (j) => matchesStatus(j.job_status_id, status) && j.stops.some((s) => s.customer_id === code)
        );
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
