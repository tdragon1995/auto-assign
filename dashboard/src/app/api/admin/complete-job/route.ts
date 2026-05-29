import { NextRequest, NextResponse } from "next/server";
import { getJobDetails, completeJob, type Env } from "@/lib/cartrack";
import { JOB_STATUS } from "@/lib/job-filters";

// ── POST /api/admin/complete-job — force-complete a job by ID ──────────────
// Body: { job_id }. Guards against jobs already completed/cancelled/failed.

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const { job_id } = await req.json();
    const jobId = Number(job_id);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return NextResponse.json({ error: "Job ID không hợp lệ" }, { status: 400 });
    }

    // Look up first so we don't blindly complete the wrong/terminal job.
    const details = await getJobDetails(jobId, env);
    const data = details.data;
    if (!data?.job_id) {
      return NextResponse.json({ error: "Không tìm thấy job" }, { status: 404 });
    }

    const statusId: number | null = data.job_status_id ?? null;
    if (statusId === 5) {
      return NextResponse.json({ error: "Job đã hoàn thành rồi" }, { status: 409 });
    }
    if (statusId === 3 || statusId === 7) {
      const label = JOB_STATUS[statusId] ?? "huỷ/thất bại";
      return NextResponse.json({ error: `Job đã ${label.toLowerCase()}` }, { status: 409 });
    }

    const result = await completeJob(jobId, env);
    if (!result.ok) {
      return NextResponse.json(
        { error: "Hoàn thành job thất bại", status: result.status, details: result.body },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true, job_id: jobId });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
