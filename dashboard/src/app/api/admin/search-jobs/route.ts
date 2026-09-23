import { NextRequest, NextResponse } from "next/server";
import { getRunLog, getFailedJobs, getHeldJobs } from "@/lib/smart-log-kv";
import { loadDriversFromSheet } from "@/lib/config";
import { searchActiveStops, type Env } from "@/lib/cartrack";
import { driversJobs, snapJobsByIds, FEED_MAX_AGE_MS, type SnapJob } from "@/lib/day-snapshot";
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
 * GET /api/admin/search-jobs?q=<customer, code, driver, PSC or job number>&env=
 *
 * JOBS ON THE ROAD ONLY. The answer is Cartrack's own search over today's stops that
 * are picked up / arrived / started (searchActiveStops — the fleetweb delivery table's
 * search box), one RPC per search. It finds a job however it was created, and it does
 * NOT pad the list with finished jobs: the log scan used to, and a search for "d007"
 * came back as 31 rows of which two were running.
 *
 * Cartrack returns only the stop in progress, so each row's route is filled in from
 * the stored day (one HMGET) — otherwise a "d007" hit read "… | BRA - D001".
 *
 * FALLBACK, only when Cartrack does not answer (`source: "fallback"`): every matching
 * driver's unfinished jobs from the day snapshot, then the activity log. The panel
 * says so, because that list is not limited to jobs on the road.
 *
 * A job that is not on the road (unassigned, not started) is opened by its number, or
 * with the "Điều chỉnh" chip on its Cần xử lý row.
 */
export async function GET(req: NextRequest) {
  const raw = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const q = raw.toLowerCase();
  if (q.length < 2) return NextResponse.json({ results: [], source: "cartrack" });

  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const today = vnDate();
  // Sent as typed: Cartrack matches accents the way its own search box does.
  const active = await searchActiveStops(today, raw, env).catch(() => null);
  if (active) return NextResponse.json({ results: await onTheRoad(active, today, env), source: "cartrack" });
  return NextResponse.json({ results: await fallback(q, today, env), source: "fallback" });
}

/** Cartrack's flat stops → one row per job, labelled with the whole route. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function onTheRoad(stops: any[], today: string, env: Env): Promise<JobSearchHit[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byJob = new Map<number, any[]>();
  for (const st of stops) {
    const id = Number(st.job_id);
    if (!Number.isInteger(id) || id <= 0) continue;
    (byJob.get(id) ?? byJob.set(id, []).get(id)!).push(st);
  }
  const ids = [...byJob.keys()].slice(0, 60);
  const [stored, drivers] = await Promise.all([
    snapJobsByIds(today, env, ids),
    loadDriversFromSheet().catch(() => []),
  ]);
  const nameOf = new Map(drivers.map((d) => [d.driver_id, d.name]));

  return ids.map((id) => {
    const own = byJob.get(id)!;
    const full = stored.get(id);
    const routeStops = full?.stops?.length ? full.stops : [...own].sort((a, b) => (a.stop_type_id ?? 9) - (b.stop_type_id ?? 9));
    const route = routeStops.map((st: { customer_name?: string }) => st.customer_name).filter(Boolean).join(" → ");
    const driverId = full?.delivery_driver_id ?? own[0]?.delivery_driver_id ?? null;
    const driver = (driverId && nameOf.get(driverId)) || own.find((st) => st.driver_name)?.driver_name || null;
    return {
      job_id: id,
      label: [driver, route].filter(Boolean).join(" | ") || `Job ${id}`,
      statusId: Number(full?.job_status_id ?? own[0]?.job_status_id) || null,
    };
  });
}

/** Cartrack unavailable: driver names from the day snapshot, then the activity log. */
async function fallback(q: string, today: string, env: Env): Promise<JobSearchHit[]> {
  const needle = foldName(q);
  const [logs, failed, held, drivers] = await Promise.all([
    getRunLog(500),
    getFailedJobs(),
    getHeldJobs(),
    loadDriversFromSheet().catch(() => []),
  ]);

  const found = new Map<number, JobSearchHit>();
  const add = (id: number, label: string, ts?: string) => {
    if (Number.isInteger(id) && id > 0 && !found.has(id)) found.set(id, { job_id: id, label, ts });
  };

  // Every matching driver at once (driversJobs: two Redis reads however many match) —
  // not the first five in roster order, which missed whoever was on the road.
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
  // A driver query stops here — log lines name the driver too, and would pull back every
  // job they touched today, finished or not. Only when it FOUND something, though: a
  // name matching only drivers with nothing open (a test account "… D001") falls through.
  if (driverHit) return [...found.values()].slice(0, 60);

  // getRunLog is oldest-first; walk newest-first so the freshest line wins.
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
  return [...found.values()].slice(0, 60);
}
