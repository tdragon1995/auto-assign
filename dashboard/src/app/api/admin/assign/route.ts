import { NextRequest, NextResponse } from "next/server";
import { assignJob, type Env } from "@/lib/cartrack";

/**
 * POST /api/admin/assign
 * Manually assign a failed job to a driver.
 * Body: { job_id: number, driver_id: string, env?: "prod" | "uat" }
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
