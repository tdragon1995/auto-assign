import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, type Env } from "@/lib/cartrack";
import { driverDisplayName, fetchJobDetail, stripDriverCode } from "@/lib/job-detail";
import { isLabWatchedClient, keepOnBranchFeed, LAB_CUSTOMER_ID } from "@/lib/job-filters";
import { driverJobs, FEED_MAX_AGE_MS, locationJobs, slimJob } from "@/lib/day-snapshot";
import { isValidDriverId, loadConfigFromSheets, loadDriversFromSheet } from "@/lib/config";
import { PSC_ROUTES } from "@/lib/psc-routes-data";
import type { Job, Stop } from "@/lib/types";

export const runtime = "nodejs";
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
// the same trip.
//
// `?fresh=1` still forces a rebuild, but NOTHING SENDS IT any more. The /qr page used to
// on every Làm mới tap and after every booking, cancel and 3PL handoff — 41% of this
// route's traffic, all of it rebuilding the whole network's day. Làm mới is gone, and the
// actions now update the branch's list from their own response. Think hard before
// reintroducing a caller: a rebuild costs ~5s of Cartrack round-trips to answer a question
// about one branch's dozen rows, and a just-created job frequently is not in the rebuilt
// answer anyway, because Cartrack has not indexed it yet.

// `status=all` returns everything the feed shows: assigned + completed from the route
// timeline, plus unassigned (2) and rejected (3) from the unrouted pool. The timeline
// alone only ever contains 4 and 5, so without the second source a branch never sees a
// request that hasn't been picked up or one a driver turned down.
const ALL_STATUSES = [2, 3, 4, 5];

/** Branches whose configured route ends at `code` — the provincial branches a hub receives.
 *  The lab is excluded by the feed rule itself, so every branch listing it does no harm. */
function feedersOf(code: string): Set<string> {
  return new Set(PSC_ROUTES.filter((r) => r.dropoff === code).map((r) => r.pickup));
}

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

  // ── ?drivers=1&code=…: the branch's configured drivers, for /qr's picker ──────────
  // Fixed and smart drivers of every config row for this branch. The config and roster
  // are in-process caches, so this costs no day read at all.
  if (req.nextUrl.searchParams.get("drivers") === "1" && code) {
    const [config, roster] = await Promise.all([
      loadConfigFromSheets().catch(() => null), loadDriversFromSheet().catch(() => []),
    ]);
    const ids = new Set((config?.mappings ?? [])
      .filter((m) => m.customer_id === code)
      .flatMap((m) => [m.driver_id, ...(m.smart_driver_id ?? [])])
      .filter((id): id is string => !!id && isValidDriverId(id)));
    // A person with a full-time and a part-time account would otherwise be listed twice
    // under one name; mark the PT one.
    const names = new Map(roster.map((d) => [d.driver_id, stripDriverCode(d.name) + (/\bPT\d/i.test(d.name) ? " (PT)" : "")]));
    const drivers = [...ids]
      .map((driver_id) => ({ driver_id, name: names.get(driver_id) ?? "" }))
      .filter((d) => d.name)
      .sort((a, b) => a.name.localeCompare(b.name, "vi"));
    return NextResponse.json({ drivers });
  }

  if (!date || !status) {
    return NextResponse.json({ error: "Missing date or status" }, { status: 400 });
  }

  try {
    // Fast path (code-scoped): one slice of the shared day snapshot. Any failure
    // (including a throw) falls back to REST rather than 500ing the branch's feed.
    const feeders = code ? feedersOf(code) : new Set<string>();

    // ── &driver=…: /qr shows trips only for the driver the branch picked ──────────────
    // That driver's entry in the shared day, narrowed to trips touching this branch by
    // the same rules as the branch feed. The day is never rebuilt for this: a few
    // minutes behind is fine for a list someone asked to look at.
    const driver = req.nextUrl.searchParams.get("driver");
    if (code && driver) {
      const theirs = await driverJobs(date, env, driver, { maxAgeMs: FEED_MAX_AGE_MS }).catch(() => null);
      // Day unavailable: fall through to the REST path below, narrowed to this driver
      // there — an empty list here would tell the branch the driver has nothing.
      if (theirs) {
        return NextResponse.json({
          jobs: theirs
            .filter((j) => matchesStatus(j.job_status_id, status))
            .filter((j) => j.stops.some((s) => s.customer_id === code) || (code === LAB_CUSTOMER_ID && isLabWatchedClient(j)))
            .filter((j) => keepOnBranchFeed(code, j, feeders)),
        });
      }
    }

    if (code && !driver) {
      const fresh = req.nextUrl.searchParams.get("fresh") === "1";
      const mine = await locationJobs(date, env, code, { fresh }).catch(() => null);
      if (mine) {
        // Location is already applied by the slice; only the status filter is left.
        return NextResponse.json({
          jobs: mine
            .filter((j) => matchesStatus(j.job_status_id, status))
            .filter((j) => keepOnBranchFeed(code, j, feeders)),
        });
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
        .filter((j) => (j.stops ?? []).some((s: Stop) => s.customer_id === code)
          || (code === LAB_CUSTOMER_ID && isLabWatchedClient(j)))
        .filter((j) => keepOnBranchFeed(code, j, feeders))
        .filter((j) => !driver || j.delivery_driver_id === driver)
        .map((j) => slimJob(j, driverDisplayName(j.driver)));
      return NextResponse.json({ jobs });
    }

    return NextResponse.json({ jobs: allJobs });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
