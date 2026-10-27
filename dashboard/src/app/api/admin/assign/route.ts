import { NextRequest, NextResponse } from "next/server";
import { assignJob, getJobDetailsFast, type Env } from "@/lib/cartrack";
import { JOB_STATUS } from "@/lib/job-filters";

/**
 * POST /api/admin/assign
 * Manually assign a failed job to a driver.
 * Body: { job_id: number, driver_id: string, env?: "prod" | "uat" }
 *
 * The job is re-read live first: the Cần xử lý row the button sat on can be minutes
 * old, and the RPC assign puts a cancelled job straight back on a driver's route
 * (job 34509625, 27/10: cancelled 15:22, assigned from here 15:24, driver sent to a
 * client who had called it off).
 */
export async function POST(req: NextRequest) {
  try {
    const reqBody = await req.json();
    const { job_id, driver_id, env = "prod" } = reqBody as {
      job_id?: number;
      driver_id?: string;
      env?: Env;
    };

    if (!job_id || !driver_id) {
      return NextResponse.json(
        { error: "job_id và driver_id là bắt buộc" },
        { status: 400 }
      );
    }

    const job = (await getJobDetailsFast(job_id, env).catch(() => null))?.data;
    if (!job?.job_id) {
      return NextResponse.json({ error: "Không đọc được chuyến từ Cartrack, vui lòng thử lại" }, { status: 502 });
    }
    if ([3, 5, 7].includes(job.job_status_id)) {
      return NextResponse.json(
        { error: `Chuyến ${JOB_STATUS[job.job_status_id].toLowerCase()} — không thể gán` },
        { status: 409 }
      );
    }

    const { status, body } = await assignJob(driver_id, job_id, env);

    if (status !== 200) {
      return NextResponse.json(
        {
          error: `Không thể gán job. Trạng thái: ${status}`,
          details: body,
        },
        { status }
      );
    }

    return NextResponse.json({
      success: true,
      message: `Job ${job_id} đã gán cho tài xế ${driver_id}`,
      job_id,
      driver_id,
    });
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}
