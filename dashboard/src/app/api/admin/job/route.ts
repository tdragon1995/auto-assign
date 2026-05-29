import { NextRequest, NextResponse } from "next/server";
import { getJobDetails, type Env } from "@/lib/cartrack";
import { isStopStarted } from "@/lib/job-filters";

// ── GET /api/admin/job?job_id=&env= — job summary for the admin job tools ──
// Shared lookup for both the "complete" and "change dropoff" sub-tabs.

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const jobIdRaw = req.nextUrl.searchParams.get("job_id")?.trim();
  const jobId = Number(jobIdRaw);

  if (!jobIdRaw || !Number.isInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: "Job ID không hợp lệ" }, { status: 400 });
  }

  try {
    const details = await getJobDetails(jobId, env);
    const data = details.data;
    if (!data?.job_id) {
      return NextResponse.json({ error: "Không tìm thấy job" }, { status: 404 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stops: any[] = data.stops ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickup = stops.find((s: any) => s.stop_type_id === 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dropoff = stops.find((s: any) => s.stop_type_id === 2);

    return NextResponse.json({
      job_id: data.job_id,
      job_status_id: data.job_status_id ?? null,
      reference_number: data.reference_number ?? null,
      delivery_driver_id: data.delivery_driver_id ?? null,
      pickup: pickup ? { customer_name: pickup.customer_name ?? null } : null,
      dropoff: dropoff
        ? {
            stop_id: dropoff.stop_id ?? null,
            customer_id: dropoff.customer_id ?? null,
            customer_name: dropoff.customer_name ?? null,
          }
        : null,
      started: stops.some((s) => isStopStarted(s)),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
