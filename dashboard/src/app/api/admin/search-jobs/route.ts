import { NextRequest, NextResponse } from "next/server";
import { getRunLog, getFailedJobs, getHeldJobs } from "@/lib/smart-log-kv";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

// Job IDs always appear as "Job <digits>" in our log lines.
const JOB_ID_RE = /\bJob (\d+)\b/g;

export interface JobSearchHit {
  job_id: number;
  label: string; // the matched activity line / customer, for context
  ts?: string;
}

/**
 * GET /api/admin/search-jobs?q=<customer name or text>
 *
 * Searches the Redis activity log (plus the held/failed snapshots) — the log
 * lines already carry the customer name next to the Job ID, so this is a free
 * in-memory scan with no Cartrack call. Coverage is whatever has logged recently
 * (~today's activity, last 500 entries); it won't find old/never-logged jobs.
 */
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
  if (q.length < 2) return NextResponse.json({ results: [] });

  const [logs, failed, held] = await Promise.all([
    getRunLog(500),
    getFailedJobs(),
    getHeldJobs(),
  ]);

  // Dedupe by job_id, keeping the newest (most relevant) label.
  const found = new Map<number, JobSearchHit>();
  const add = (id: number, label: string, ts?: string) => {
    if (Number.isInteger(id) && id > 0 && !found.has(id)) found.set(id, { job_id: id, label, ts });
  };

  // getRunLog is oldest-first; walk newest-first so the freshest line wins.
  for (let i = logs.length - 1; i >= 0; i--) {
    const l = logs[i];
    if (!l.msg.toLowerCase().includes(q)) continue;
    for (const m of l.msg.matchAll(JOB_ID_RE)) add(Number(m[1]), l.msg, l.ts);
  }
  for (const j of failed) {
    if (j.customer.toLowerCase().includes(q)) add(j.job_id, `${j.customer} — ${j.detail}`, j.ts);
  }
  for (const j of held) {
    if (j.customer.toLowerCase().includes(q)) add(j.job_id, `${j.customer} (chờ duyệt ghi chú)`);
  }

  const results = [...found.values()].slice(0, 60);
  return NextResponse.json({ results });
}
