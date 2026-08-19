/**
 * Archive a day's driver routes into Supabase (tat_trips).
 *
 * WHY A SEPARATE CRON RATHER THAN A HOOK IN THE ASSIGN CYCLE
 *   The cycle already fetches this exact payload every ~3 minutes, so piggybacking
 *   would save the Cartrack call. It would also put a Supabase write on the path
 *   that assigns jobs, where a slow or failed write becomes an assignment problem.
 *   The archive is a reporting concern with no deadline; it gets its own trigger,
 *   the same way the daily Zalo report does.
 *
 * Auth matches /api/assign/cron: CRON_SECRET as a Bearer token or x-cron-secret
 * header, and open when the variable is unset.
 */
import { NextRequest, NextResponse } from "next/server";
import { archiveDay, type ArchiveResult } from "@/lib/tat-archive";
import { vnDate } from "@/lib/time";
import type { Env } from "@/lib/cartrack";

// A whole day of routes plus a cold-cache distance fill can run long. The first
// few runs are the expensive ones — once each leg's pair is in the distance
// cache, later runs make no Goong calls at all.
export const runtime = "nodejs";
export const maxDuration = 60;
export const preferredRegion = "sin1";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return (
    req.headers.get("authorization") === `Bearer ${secret}` ||
    req.headers.get("x-cron-secret") === secret
  );
}

/**
 * GET /api/tat/archive
 *   ?date=YYYY-MM-DD   one day (defaults to today VN)
 *   ?days=N            that day and the N-1 days before it, for backfill
 *   ?env=prod|uat
 *
 * Backfill runs sequentially: a burst of parallel Cartrack day-fetches is the one
 * thing most likely to get this throttled, and nothing here is urgent.
 */
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const env = (sp.get("env") ?? "prod") as Env;
  const start = sp.get("date") ?? vnDate();
  const days = Math.min(Math.max(Number(sp.get("days") ?? 1) || 1, 1), 31);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return NextResponse.json({ ok: false, error: "date phải có dạng YYYY-MM-DD" }, { status: 400 });
  }

  const results: ArchiveResult[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    results.push(await archiveDay(d.toISOString().slice(0, 10), env));
  }

  const ok = results.every((r) => r.ok);
  return NextResponse.json({ ok, results }, { status: ok ? 200 : 502 });
}
