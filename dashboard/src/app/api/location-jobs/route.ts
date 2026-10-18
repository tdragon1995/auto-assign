import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, isProxyDriver, type Env } from "@/lib/cartrack";
import { driverDisplayName, fetchJobDetail } from "@/lib/job-detail";
import { isLabWatchedClient, keepOnBranchFeed, LAB_CUSTOMER_ID } from "@/lib/job-filters";
import { jobsByIds, locationJobs, slimJob } from "@/lib/day-snapshot";
import { sbRpc, supabaseConfigured } from "@/lib/supabase-rest";
import { targetMinsFor } from "@/lib/tat";
import { vnDate } from "@/lib/time";
import type { Job } from "@/lib/types";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

// The /qr page's trips (only caller):
//   ?job_id=123                  full detail for the job sheet
//   ?date=…&code=…&all=1&ids=…   the whole branch plus own bookings, and `eta` — minutes
//                                pickup→here per pickup branch, for runs coming in
//   ?date=…&code=…&ids=…         only those ids (tabs from before 2026-10-18)
// From the shared day (@/lib/day-snapshot), which rebuilds when stale; when it is
// unavailable the REST day is filtered the same way. Statuses 2-5: what the timeline
// carries (4, 5) and the unrouted pool (2, 3) — cancelled (7) never shows.
const SHOWN_STATUSES = [2, 3, 4, 5];

/** Below this many trips in 30 days a route's p80 is noise; use the per-km rule instead. */
const ETA_MIN_TRIPS = 5;
const ETA_TTL_MS = 3_600_000;
const etaCache = new Map<string, { at: number; mins: Record<string, number> }>();

/** Minutes from pickup finished to delivered, per pickup, for trips into `code` — the p80
 *  of the last 30 days (Supabase route_eta_into, off pay_jobs). The page adds it to the
 *  pickup time for the "coming in" block. An hour's staleness is nothing for a 30-day
 *  figure; Supabase has no request cap, so a cold instance just asks again. Empty on any
 *  failure: no ETA is shown, nothing else changes. */
async function etaInto(code: string): Promise<Record<string, number>> {
  const hit = etaCache.get(code);
  if (hit && Date.now() - hit.at < ETA_TTL_MS) return hit.mins;
  if (!supabaseConfigured()) return {};
  try {
    const rows = await sbRpc<{ pickup_customer_id: string; trips: number; p80_mins: number; km: number | null }[]>(
      "route_eta_into", { p_dropoff: code },
    );
    const mins: Record<string, number> = {};
    for (const r of rows ?? []) {
      const m = r.trips >= ETA_MIN_TRIPS ? r.p80_mins : targetMinsFor(r.km == null ? null : Number(r.km));
      if (m) mins[r.pickup_customer_id] = m;
    }
    etaCache.set(code, { at: Date.now(), mins });
    return mins;
  } catch (e) {
    console.error("[location-jobs] route eta", e);
    return {};
  }
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
    const touches = (j: { stops?: { customer_id?: string | null; stop_type_id?: number; customer_name?: string }[] | null }) =>
      (j.stops ?? []).some((s) => s.customer_id === code) || (code === LAB_CUSTOMER_ID && isLabWatchedClient(j));
    // D001 does not show trips going to an NĐTP drop-off at all — they have /ndtp — nor
    // trips sitting on a proxy driver (parked until their time, or staged for rejection).
    const listed = (j: { job_status_id?: number; delivery_driver_id?: string | null; stops?: { stop_type_id?: number; customer_name?: string | null }[] | null }) =>
      SHOWN_STATUSES.includes(j.job_status_id ?? 0)
      && !(code === LAB_CUSTOMER_ID && (
        isProxyDriver(j.delivery_driver_id ?? "")
        || /NDTP/i.test((j.stops ?? []).find((s) => s.stop_type_id === 2)?.customer_name ?? "")));
    const ids = (req.nextUrl.searchParams.get("ids") ?? "").split(",").map(Number).filter(Number.isInteger).slice(0, 50);
    // The whole branch (every /qr page since 2026-10-18), or only the given ids.
    const wholeBranch = req.nextUrl.searchParams.get("all") === "1" || ids.length === 0;
    // ETAs for runs still coming in — today only, and not the lab, which lists clients.
    const etaP = wholeBranch && code !== LAB_CUSTOMER_ID && date === vnDate() ? etaInto(code) : Promise.resolve({});

    const day = wholeBranch
      ? await locationJobs(date, env, code).catch(() => null)
      : await jobsByIds(date, env, ids).catch(() => null);
    if (day) {
      const jobs = day.filter((j) => listed(j) && (!wholeBranch || keepOnBranchFeed(code, j)));
      // Own bookings the day no longer has at all (cancelled or deleted in Cartrack): the
      // page drops their waiting cards instead of showing them all day.
      const missing = ids.filter((id) => !day.some((j) => j.job_id === id));
      return NextResponse.json({ jobs, missing, eta: await etaP });
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
        .filter((j) => listed(j) && (wholeBranch ? touches(j) && keepOnBranchFeed(code, j) : ids.includes(j.job_id)))
        .map((j) => slimJob(j, driverDisplayName(j.driver))),
      eta: await etaP,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
