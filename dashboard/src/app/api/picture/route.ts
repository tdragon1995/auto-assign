import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { getJobsByStatusAndDate, type Env } from "@/lib/cartrack";
import { driverDisplayName } from "@/lib/job-detail";
import { sbSelect, sbUpsert, supabaseConfigured, missingSupabaseEnv } from "@/lib/supabase-rest";
import { PR_COOKIE, reviewerEmail } from "@/lib/review-session";
import { vnDate } from "@/lib/time";
import { FAIL_REASON_CODES } from "@/lib/photo-review";
import type { Job, Stop } from "@/lib/types";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

interface ReviewRow { job_id: number }

interface QueueJob {
  job_id: number;
  reference_number: string | null;
  completed_ts: string | null;
  driver: string | null;
  pickup: string;
  dropoff: string;
}

/**
 * The day's completed jobs cost 5.2 s and 5.2 MB from Cartrack — measured, one page,
 * 543 jobs — and every load of /picture was paying it again. Two minutes of staleness
 * costs a reviewer nothing: they work newest-first and will not reach the end of the
 * day in that time, and a job finishing in the gap simply appears on the next load.
 *
 * The REVIEWED set is deliberately applied AFTER this cache, against Supabase, so a
 * verdict removes its job from the queue immediately rather than two minutes later.
 */
const QUEUE_TTL_S = 120;

function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function dayQueue(date: string, env: Env): Promise<{ jobs: QueueJob[]; cached: boolean }> {
  const redis = getRedis();
  const cacheKey = `picture:queue:v1:${env}:${date}`;
  if (redis) {
    try {
      const hit = await redis.get<QueueJob[]>(cacheKey);
      if (hit) return { jobs: hit, cached: true };
    } catch { /* fall through to a live fetch */ }
  }

  const jobs = (await getJobsByStatusAndDate(5, date, env))
    .map((j) => ({
      job_id: j.job_id,
      reference_number: j.reference_number ?? null,
      completed_ts: completedTs(j),
      driver: driverDisplayName(j.driver),
      pickup: (j.stops ?? []).find((s: Stop) => s.stop_type_id === 1)?.customer_name ?? "",
      dropoff: (j.stops ?? []).find((s: Stop) => s.stop_type_id !== 1)?.customer_name ?? "",
    }))
    .sort((a, b) => (b.completed_ts ?? "").localeCompare(a.completed_ts ?? ""));

  if (redis) {
    try { await redis.set(cacheKey, jobs, { ex: QUEUE_TTL_S }); } catch { /* best-effort */ }
  }
  return { jobs, cached: false };
}

/** The job's finishing time = the last stop it completed. Jobs are offered newest-first
 *  off this, not off scheduled_delivery_ts: the reviewer wants what the drivers just
 *  shot, and a job scheduled at 08:00 can finish after one scheduled at 11:00. */
function completedTs(j: Job): string | null {
  const times = (j.stops ?? [])
    .map((s: Stop) => s.activity_completed_ts)
    .filter((t): t is string => !!t)
    .sort();
  return times.length ? times[times.length - 1] : null;
}

// ── GET /api/picture — the review queue ──────────────────────────────────────
// Today's COMPLETED jobs, newest finish first, minus everything already reviewed.
// Carries no photos: whether a job has any is only knowable from the per-job detail
// call, so the client pulls that one job at a time (and it is Redis-cached for a day
// on a completed job, shared with the /qr job sheet).
export async function GET(req: NextRequest) {
  const email = reviewerEmail(req.cookies.get(PR_COOKIE)?.value);
  if (!email) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  if (!supabaseConfigured()) {
    return NextResponse.json(
      { error: `Supabase chưa cấu hình: ${missingSupabaseEnv().join(", ")}` },
      { status: 503 },
    );
  }

  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const date = req.nextUrl.searchParams.get("date") || vnDate();

  try {
    const [day, reviewed] = await Promise.all([
      dayQueue(date, env),
      sbSelect<ReviewRow>("photo_reviews", `select=job_id&review_date=eq.${date}`),
    ]);
    const done = new Set(reviewed.map((r) => Number(r.job_id)));
    const queue = day.jobs.filter((j) => !done.has(Number(j.job_id)));

    return NextResponse.json({ email, date, queue, total: day.jobs.length, cached: day.cached });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── POST /api/picture — file one verdict ─────────────────────────────────────
// Body: { job_id, result: "pass" | "fail", reason?, photo_count?, date? }
// The email comes from the signed cookie and never from the body, so a verdict is
// always attributable to the person who logged in.
export async function POST(req: NextRequest) {
  const email = reviewerEmail(req.cookies.get(PR_COOKIE)?.value);
  if (!email) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Yêu cầu không hợp lệ." }, { status: 400 });
  }

  const jobId = Number(body?.job_id);
  const result = String(body?.result ?? "");
  const reason = body?.reason ? String(body.reason) : null;

  if (!Number.isFinite(jobId) || jobId <= 0) {
    return NextResponse.json({ error: "job_id không hợp lệ." }, { status: 400 });
  }
  if (result !== "pass" && result !== "fail") {
    return NextResponse.json({ error: "result phải là pass hoặc fail." }, { status: 400 });
  }
  if (result === "fail" && !(reason && FAIL_REASON_CODES.includes(reason))) {
    return NextResponse.json({ error: "Chọn lý do không đạt." }, { status: 400 });
  }

  try {
    await sbUpsert(
      "photo_reviews",
      [{
        job_id: jobId,
        review_date: String(body?.date ?? "") || vnDate(),
        result,
        reason: result === "fail" ? reason : null,
        reviewer_email: email,
        photo_count: Number(body?.photo_count ?? 0) || 0,
        reviewed_at: new Date().toISOString(),
      }],
      "job_id",
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
