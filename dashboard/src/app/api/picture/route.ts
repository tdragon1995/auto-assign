import { NextRequest, NextResponse } from "next/server";
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
    const [jobs, reviewed] = await Promise.all([
      getJobsByStatusAndDate(5, date, env),
      sbSelect<ReviewRow>("photo_reviews", `select=job_id&review_date=eq.${date}`),
    ]);
    const done = new Set(reviewed.map((r) => Number(r.job_id)));

    const queue = jobs
      .filter((j) => !done.has(Number(j.job_id)))
      .map((j) => ({
        job_id: j.job_id,
        reference_number: j.reference_number ?? null,
        completed_ts: completedTs(j),
        driver: driverDisplayName(j.driver),
        pickup: (j.stops ?? []).find((s: Stop) => s.stop_type_id === 1)?.customer_name ?? "",
        dropoff: (j.stops ?? []).find((s: Stop) => s.stop_type_id !== 1)?.customer_name ?? "",
      }))
      .sort((a, b) => (b.completed_ts ?? "").localeCompare(a.completed_ts ?? ""));

    return NextResponse.json({ email, date, queue, total: jobs.length });
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
