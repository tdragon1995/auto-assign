import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, type Env } from "@/lib/cartrack";
import { driverDisplayName, fetchJobDetail } from "@/lib/job-detail";
import { isLabWatchedClient, keepOnBranchFeed, LAB_CUSTOMER_ID } from "@/lib/job-filters";
import { jobsByIds, locationJobs, slimJob } from "@/lib/day-snapshot";
import { PSC_ROUTES } from "@/lib/psc-routes-data";
import type { Job } from "@/lib/types";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

// The /qr page's trips (only caller):
//   ?job_id=123                  full detail for the job sheet
//   ?date=…&code=…&all=1&ids=…   the whole branch (D001, D046) plus own bookings
//   ?date=…&code=…&ids=…         only the device's own bookings (every other branch)
// From the shared day (@/lib/day-snapshot), which rebuilds when stale; when it is
// unavailable the REST day is filtered the same way. Statuses 2-5: what the timeline
// carries (4, 5) and the unrouted pool (2, 3) — cancelled (7) never shows.
const SHOWN_STATUSES = [2, 3, 4, 5];

/** Branches whose configured route ends at `code` — the provincial branches a hub receives.
 *  The lab is excluded by the feed rule itself, so every branch listing it does no harm. */
function feedersOf(code: string): Set<string> {
  return new Set(PSC_ROUTES.filter((r) => r.dropoff === code).map((r) => r.pickup));
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
  const code = req.nextUrl.searchParams.get("code");

  if (!date || !code) {
    return NextResponse.json({ error: "Missing date or code" }, { status: 400 });
  }

  try {
    const feeders = feedersOf(code);
    const touches = (j: { stops?: { customer_id?: string | null; stop_type_id?: number; customer_name?: string }[] | null }) =>
      (j.stops ?? []).some((s) => s.customer_id === code) || (code === LAB_CUSTOMER_ID && isLabWatchedClient(j));
    // (D001 hides NĐTP drop-offs from its list on the page itself: its driver chips still
    // need them, to say where those drivers go instead of the lab.)
    const listed = (j: { job_status_id?: number }) => SHOWN_STATUSES.includes(j.job_status_id ?? 0);
    const ids = (req.nextUrl.searchParams.get("ids") ?? "").split(",").map(Number).filter(Number.isInteger).slice(0, 50);
    // The whole branch (D001 / D046, and /qr tabs from before 2026-10-14), or only the
    // device's own bookings (every other branch: they book, they do not browse).
    const wholeBranch = req.nextUrl.searchParams.get("all") === "1" || ids.length === 0;

    const day = wholeBranch
      ? await locationJobs(date, env, code).catch(() => null)
      : await jobsByIds(date, env, ids).catch(() => null);
    if (day) {
      const jobs = day.filter((j) => listed(j) && (!wholeBranch || keepOnBranchFeed(code, j, feeders)));
      // Own bookings the day no longer has at all (cancelled or deleted in Cartrack): the
      // page drops their waiting cards instead of showing them all day.
      const missing = ids.filter((id) => !day.some((j) => j.job_id === id));
      return NextResponse.json({ jobs, missing });
    }

    // Day unavailable: the REST day, filtered the same way — an empty list here would
    // leave a booking waiting forever.
    const res = await fetch(
      `${BASE_URL}/jobs?filter[scheduled_delivery_ts_from]=${date} 00:00:00&filter[scheduled_delivery_ts_to]=${date} 23:59:59&limit=1000`,
      { headers: getHeaders(env), cache: "no-store" },
    );
    if (!res.ok) return NextResponse.json({ jobs: [] });
    const allJobs: Job[] = (await res.json()).data ?? [];
    return NextResponse.json({
      jobs: allJobs
        .filter((j) => listed(j) && (wholeBranch ? touches(j) && keepOnBranchFeed(code, j, feeders) : ids.includes(j.job_id)))
        .map((j) => slimJob(j, driverDisplayName(j.driver))),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
