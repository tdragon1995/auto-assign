import { NextRequest, NextResponse } from "next/server";
import { getRunLog, getFailedJobs, getHeldJobs } from "@/lib/smart-log-kv";
import { loadDriversFromSheet } from "@/lib/config";
import type { Env } from "@/lib/cartrack";
import { driverJobs, FEED_MAX_AGE_MS, type SnapJob } from "@/lib/day-snapshot";
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
 * GET /api/admin/search-jobs?q=<customer or driver name>&env=
 *
 * A driver-name match lists that driver's unfinished jobs today from the day snapshot (up to 5 drivers).
 * Otherwise a log scan — no Cartrack call. The activity log + held/failed snapshots
 * carry the customer name next to the Job ID. Coverage is whatever logged recently
 * (~today, last 500 entries).
 */
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
  if (q.length < 2) return NextResponse.json({ results: [] });

  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const needle = foldName(q);
  const [logs, failed, held, drivers] = await Promise.all([
    getRunLog(500),
    getFailedJobs(),
    getHeldJobs(),
    loadDriversFromSheet().catch(() => []),
  ]);
  // Driver-name match → that driver's unfinished jobs TODAY, from the day snapshot the
  // cron publishes every ~3 min (no Cartrack call when it is fresh). Capped: a two-letter
  // query matches half the roster.
  const today = vnDate();
  const matchedDrivers = drivers.filter((d) => foldName(d.name).includes(needle)).slice(0, 5);
  const byDriver = await Promise.all(
    matchedDrivers.map((d) =>
      driverJobs(today, env, d.driver_id, { maxAgeMs: FEED_MAX_AGE_MS })
        .then((jobs) => ({ d, jobs: (jobs ?? []).filter((j) => !isFinished(j)) }))
        .catch(() => ({ d, jobs: [] })),
    ),
  );

  // Dedupe by job_id, keeping the newest (most relevant) line.
  const found = new Map<number, JobSearchHit>();
  const add = (id: number, label: string, ts?: string) => {
    if (Number.isInteger(id) && id > 0 && !found.has(id)) found.set(id, { job_id: id, label, ts });
  };

  for (const { d, jobs } of byDriver) {
    for (const j of jobs) {
      const route = j.stops?.map((st) => st.customer_name).filter(Boolean).join(" → ");
      if (!found.has(j.job_id)) found.set(j.job_id, { job_id: j.job_id, label: `${d.name}${route ? ` | ${route}` : ""}`, statusId: Number(j.job_status_id) || null });
    }
  }

  // A driver query stops here: log lines name the driver too, and would pull back every
  // job they touched today, finished or not.
  if (matchedDrivers.length) return NextResponse.json({ results: [...found.values()].slice(0, 60) });

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

  const results = [...found.values()].slice(0, 60);
  return NextResponse.json({ results });
}
