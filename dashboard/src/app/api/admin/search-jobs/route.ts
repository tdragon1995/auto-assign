import { NextRequest, NextResponse } from "next/server";
import { getRunLog, getFailedJobs, getHeldJobs } from "@/lib/smart-log-kv";
import { loadDriversFromSheet } from "@/lib/config";
import { searchActiveStops, type Env } from "@/lib/cartrack";
import { driversJobs, FEED_MAX_AGE_MS, type SnapJob } from "@/lib/day-snapshot";
import { vnDate } from "@/lib/time";
import { isCompletedOrRejectedStop } from "@/lib/job-filters";
import { foldName } from "@/lib/driver-cell";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

const TERMINAL = new Set([3, 5, 7]); // rejected, completed, cancelled

/** The timeline can carry the status as a string ("5"), and it lags the stops — so a
 *  job counts as finished when either its status says so or every stop is done. */
function isFinished(j: SnapJob): boolean {
  if (TERMINAL.has(Number(j.job_status_id))) return true;
  return j.stops.length > 0 && j.stops.every((s) => isCompletedOrRejectedStop(Number(s.stop_status_id)));
}

// Job IDs always appear as "Job <digits>" in our log lines.
const JOB_ID_RE = /\bJob (\d+)\b/g;

export interface JobSearchHit {
  job_id: number;
  label: string; // customer name pulled out of the matched log line
  ts?: string;
  statusId?: number | null;
}

/** Pull the customer out of a log line. Every line follows the uniform convention
 *  "<detail> | <pickup> → <dropoff>" (a single " | "), so the route is just the
 *  trailing segment. See docs/log-templates.md. */
function extractCustomer(msg: string): string {
  return msg.split(" | ").pop()?.trim() ?? msg;
}

/**
 * GET /api/admin/search-jobs?q=<customer, code, driver or job number>&env=
 *
 * Three sources, in this order, deduped by job:
 *
 * 1. CARTRACK — today's stops that are on the road (picked up / arrived / started)
 *    matching the text, through the delivery table's own search (searchActiveStops).
 *    This is what finds a job in progress however it was created; the log below only
 *    knows jobs the engine touched recently. One Cartrack call per search.
 * 2. DRIVER NAME — every matching driver's unfinished jobs today from the day snapshot
 *    (two Redis reads however many drivers match). A driver query stops after this when
 *    it found something: log lines name the driver too, and would pull back every job
 *    they touched today, finished or not.
 * 3. LOG SCAN — the activity log + held/failed snapshots, which carry the customer name
 *    next to the Job ID (~today, last 500 entries). Still how an UNASSIGNED job is found,
 *    since it has no stop on the road yet.
 */
export async function GET(req: NextRequest) {
  const raw = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const q = raw.toLowerCase();
  if (q.length < 2) return NextResponse.json({ results: [] });

  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const needle = foldName(q);
  const today = vnDate();
  const [active, logs, failed, held, drivers] = await Promise.all([
    // Sent as typed: Cartrack matches the accents the way its own search box does.
    searchActiveStops(today, raw, env).catch(() => null),
    getRunLog(500),
    getFailedJobs(),
    getHeldJobs(),
    loadDriversFromSheet().catch(() => []),
  ]);
  const nameOf = new Map(drivers.map((d) => [d.driver_id, d.name]));

  const found = new Map<number, JobSearchHit>();
  const add = (id: number, label: string, ts?: string) => {
    if (Number.isInteger(id) && id > 0 && !found.has(id)) found.set(id, { job_id: id, label, ts });
  };

  // 1. On the road, per Cartrack. Stops arrive flat; group them back into jobs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stopsByJob = new Map<number, any[]>();
  for (const st of active ?? []) {
    const id = Number(st.job_id);
    if (!Number.isInteger(id) || id <= 0) continue;
    (stopsByJob.get(id) ?? stopsByJob.set(id, []).get(id)!).push(st);
  }
  for (const [id, stops] of stopsByJob) {
    stops.sort((a, b) => (a.stop_type_id ?? 9) - (b.stop_type_id ?? 9));
    const route = [...new Set(stops.map((st) => st.customer_name).filter(Boolean))].join(" → ");
    const driver = nameOf.get(stops[0]?.delivery_driver_id) ?? stops.find((st) => st.driver_name)?.driver_name ?? null;
    found.set(id, {
      job_id: id,
      label: [driver, route].filter(Boolean).join(" | ") || `Job ${id}`,
      statusId: Number(stops[0]?.job_status_id) || null,
    });
  }

  // 2. Driver name → those drivers' unfinished jobs TODAY, from the day snapshot the
  // cron publishes every ~3 min. NOT capped by driver: it used to take the first five
  // matches in roster order, and "quang" (10 drivers) or "nguyen" (60) then missed
  // whoever was actually on the road. driversJobs reads them all in one go.
  const matchedDrivers = drivers.filter((d) => foldName(d.name).includes(needle));
  const jobsOf = matchedDrivers.length
    ? await driversJobs(today, env, matchedDrivers.map((d) => d.driver_id), { maxAgeMs: FEED_MAX_AGE_MS })
        .catch(() => null)
    : null;
  let driverHit = false;
  for (const d of matchedDrivers) {
    for (const j of (jobsOf?.get(d.driver_id) ?? []).filter((x) => !isFinished(x))) {
      driverHit = true;
      if (found.has(j.job_id)) continue;
      const route = j.stops?.map((st) => st.customer_name).filter(Boolean).join(" → ");
      found.set(j.job_id, { job_id: j.job_id, label: `${d.name}${route ? ` | ${route}` : ""}`, statusId: Number(j.job_status_id) || null });
    }
  }
  // Only when it FOUND something — a name that matches only drivers with nothing open
  // (a test account called "… D001", someone off shift) is searched as a customer.
  if (driverHit) return NextResponse.json({ results: [...found.values()].slice(0, 60) });

  // 3. getRunLog is oldest-first; walk newest-first so the freshest line wins.
  for (let i = logs.length - 1; i >= 0; i--) {
    const l = logs[i];
    if (!foldName(l.msg).includes(needle)) continue;
    const customer = extractCustomer(l.msg);
    for (const m of l.msg.matchAll(JOB_ID_RE)) add(Number(m[1]), customer, l.ts);
  }
  for (const j of failed) {
    if (foldName(j.customer).includes(needle)) add(j.job_id, j.customer, j.ts);
  }
  for (const j of held) {
    if (foldName(j.customer).includes(needle)) add(j.job_id, j.customer);
  }

  const results = [...found.values()].slice(0, 60);
  return NextResponse.json({ results });
}
