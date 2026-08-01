import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, type Env } from "@/lib/cartrack";
import { driverDisplayName, fetchJobDetail } from "@/lib/job-detail";
import { locationJobs, slimJob } from "@/lib/day-snapshot";
import type { Job, Stop } from "@/lib/types";

export const runtime = "edge";
export const preferredRegion = "sin1";

// GET /api/location-jobs?date=2026-04-11&status=4&code=<customer_uuid>
//   Location-scoped list for the /qr page: only jobs touching `code`, slimmed to
//   the fields the list renders. The old whole-day dump was ~220 KB per tap and
//   the phone discarded 99% of it (all locations, todos, POD images).
// GET /api/location-jobs?job_id=123
//   Full detail for one job (address, todos, POD image URLs) — fetched only when
//   staff open the job sheet.
// Without `code`, returns the legacy whole-day dump so cached bundles keep working.
//
// The day itself — fetch, parse, cache, projections — lives in @/lib/day-snapshot,
// shared with the duplicate guard so the feed and the guard can never disagree about
// the same trip. `?fresh=1` (Làm mới, post-cancel and post-3PL reloads) rebuilds.

// `status=all` returns everything the feed shows: assigned + completed from the route
// timeline, plus unassigned (2) and rejected (3) from the unrouted pool. The timeline
// alone only ever contains 4 and 5, so without the second source a branch never sees a
// request that hasn't been picked up or one a driver turned down.
const ALL_STATUSES = [2, 3, 4, 5];
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
    // Fast path (code-scoped): one slice of the shared day snapshot. Any failure
    // (including a throw) falls back to REST rather than 500ing the branch's feed.
    if (code) {
      const fresh = req.nextUrl.searchParams.get("fresh") === "1";
      const mine = await locationJobs(date, env, code, { fresh }).catch(() => null);
      if (mine) {
        // Location is already applied by the slice; only the status filter is left.
        return NextResponse.json({ jobs: mine.filter((j) => matchesStatus(j.job_status_id, status)) });
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
    const allJobs: Job[] = data.data ?? [];

    // Code-scoped REST fallback: same filter + slim as the fast path.
    if (code) {
      const jobs = allJobs
        .filter((j) => matchesStatus(j.job_status_id, status))
        .filter((j) => (j.stops ?? []).some((s: Stop) => s.customer_id === code))
        .map((j) => slimJob(j, driverDisplayName(j.driver)));
      return NextResponse.json({ jobs });
    }

    return NextResponse.json({ jobs: allJobs });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
