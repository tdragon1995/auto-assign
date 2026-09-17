import { NextRequest, NextResponse } from "next/server";
import { getRunLog, getFailedJobs, getHeldJobs } from "@/lib/smart-log-kv";
import { loadDriversFromSheet } from "@/lib/config";
import { getAllAssignedDriverJobs, type Env } from "@/lib/cartrack";
import { foldName } from "@/lib/driver-cell";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

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
 * A driver-name match lists that driver's assigned jobs from Cartrack (up to 5 drivers).
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
  // Driver-name match → that driver's open (assigned, unfinished) jobs, straight from
  // Cartrack. Capped: a two-letter query matches half the roster.
  const matchedDrivers = drivers.filter((d) => foldName(d.name).includes(needle)).slice(0, 5);
  const driverJobs = await Promise.all(
    matchedDrivers.map((d) => getAllAssignedDriverJobs(d.driver_id, env).then((jobs) => ({ d, jobs })).catch(() => ({ d, jobs: [] }))),
  );

  // Dedupe by job_id, keeping the newest (most relevant) line.
  const found = new Map<number, JobSearchHit>();
  const add = (id: number, label: string, ts?: string) => {
    if (Number.isInteger(id) && id > 0 && !found.has(id)) found.set(id, { job_id: id, label, ts });
  };

  for (const { d, jobs } of driverJobs) {
    for (const j of jobs) {
      const route = j.stops?.map((st) => st.customer_name ?? st.name).filter(Boolean).join(" → ");
      if (!found.has(j.job_id)) found.set(j.job_id, { job_id: j.job_id, label: `${d.name}${route ? ` | ${route}` : ""}`, statusId: j.job_status_id ?? null });
    }
  }

  // getRunLog is oldest-first; walk newest-first so the freshest line wins.
  for (let i = logs.length - 1; i >= 0; i--) {
    const l = logs[i];
    if (!l.msg.toLowerCase().includes(q)) continue;
    const customer = extractCustomer(l.msg);
    for (const m of l.msg.matchAll(JOB_ID_RE)) add(Number(m[1]), customer, l.ts);
  }
  for (const j of failed) {
    if (j.customer.toLowerCase().includes(q)) add(j.job_id, j.customer, j.ts);
  }
  for (const j of held) {
    if (j.customer.toLowerCase().includes(q)) add(j.job_id, j.customer);
  }

  const results = [...found.values()].slice(0, 60);
  return NextResponse.json({ results });
}
