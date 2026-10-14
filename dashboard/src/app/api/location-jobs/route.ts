import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, type Env } from "@/lib/cartrack";
import { driverDisplayName, fetchJobDetail, stripDriverCode } from "@/lib/job-detail";
import { isLabWatchedClient, keepOnBranchFeed, LAB_CUSTOMER_ID } from "@/lib/job-filters";
import { driverJobs, FEED_MAX_AGE_MS, locationJobs, slimJob, snapJobsByIds } from "@/lib/day-snapshot";
import { isValidDriverId, loadConfigFromSheets, loadDriversFromSheet } from "@/lib/config";
import { PSC_ROUTES } from "@/lib/psc-routes-data";
import type { Job } from "@/lib/types";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

// The /qr page's trips (only caller). Three shapes:
//   ?job_id=123                      full detail for the job sheet
//   ?drivers=1&code=…                the branch's configured drivers, for the picker
//   ?date=…&code=…&driver=…&ids=…    the picked driver's trips touching the branch, plus
//                                    the branch's own bookings by id
// Everything comes from the shared day (@/lib/day-snapshot), never rebuilt here; when it
// is unavailable the REST day is filtered the same way. Statuses 2-5: what the timeline
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

  if (!date || !code) {
    return NextResponse.json({ error: "Missing date or code" }, { status: 400 });
  }

  try {
    const feeders = feedersOf(code);
    const touches = (j: { stops?: { customer_id?: string | null; stop_type_id?: number; customer_name?: string }[] | null }) =>
      (j.stops ?? []).some((s) => s.customer_id === code) || (code === LAB_CUSTOMER_ID && isLabWatchedClient(j));
    const shown = (j: { job_status_id?: number }) => SHOWN_STATUSES.includes(j.job_status_id ?? 0);
    const driver = req.nextUrl.searchParams.get("driver");
    const ids = (req.nextUrl.searchParams.get("ids") ?? "").split(",").map(Number).filter(Number.isInteger).slice(0, 50);

    if (driver || ids.length) {
      const [theirs, own] = await Promise.all([
        driver ? driverJobs(date, env, driver, { maxAgeMs: FEED_MAX_AGE_MS }).catch(() => null) : [],
        snapJobsByIds(date, env, ids),
      ]);
      // Driver's day unavailable: fall through to REST — an empty list here would tell
      // the branch the driver has nothing.
      if (theirs) {
        const byId = new Map(own);
        for (const j of theirs) if (touches(j) && keepOnBranchFeed(code, j, feeders)) byId.set(j.job_id, j);
        return NextResponse.json({ jobs: [...byId.values()].filter(shown) });
      }
    } else {
      // ponytail: whole-branch list, kept only for /qr tabs opened before 2026-10-14 that
      // still send neither driver nor ids. Delete once those tabs have reloaded.
      const mine = await locationJobs(date, env, code).catch(() => null);
      if (mine) return NextResponse.json({ jobs: mine.filter(shown).filter((j) => keepOnBranchFeed(code, j, feeders)) });
    }

    const res = await fetch(
      `${BASE_URL}/jobs?filter[scheduled_delivery_ts_from]=${date} 00:00:00&filter[scheduled_delivery_ts_to]=${date} 23:59:59&limit=1000`,
      { headers: getHeaders(env), cache: "no-store" },
    );
    if (!res.ok) return NextResponse.json({ jobs: [] });
    const allJobs: Job[] = (await res.json()).data ?? [];
    return NextResponse.json({
      jobs: allJobs
        .filter((j) => shown(j) && touches(j) && keepOnBranchFeed(code, j, feeders))
        .filter((j) => (!driver && !ids.length) || j.delivery_driver_id === driver || ids.includes(j.job_id))
        .map((j) => slimJob(j, driverDisplayName(j.driver))),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
