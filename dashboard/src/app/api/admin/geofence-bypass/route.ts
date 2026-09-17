import { NextRequest, NextResponse, after } from "next/server";
import { getJobDetailsFast, type Env } from "@/lib/cartrack";
import { loadDriversFromSheet } from "@/lib/config";
import { openGeofence, queueBypassLog } from "@/lib/geofence-bypass";
import { isCompletedOrRejectedStop } from "@/lib/job-filters";
import { vnTimestamp } from "@/lib/time";

// ── POST /api/admin/geofence-bypass — let a job's driver complete stops off-site for 5 min ──
// Body: { job_id, driver_id }. Opens first and answers; the job lookup for the log runs in
// after() and is queued in Redis. The assign cron restores enforcement and writes the queued
// rows to the "Mở Geofence Log" tab: Lấy mẫu while the pickup stop is not yet completed at
// click time, otherwise Giao mẫu.

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const { job_id, driver_id } = await req.json().catch(() => ({}));
  const jobId = Number(job_id);
  if (!Number.isInteger(jobId) || jobId <= 0 || typeof driver_id !== "string" || !/^[0-9a-f-]{36}$/i.test(driver_id)) {
    return NextResponse.json({ error: "Job ID hoặc tài xế không hợp lệ" }, { status: 400 });
  }
  const clickedAt = new Date();

  const out = await openGeofence(driver_id, env);
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: 502 });

  after(async () => {
    try {
      const [data, drivers] = await Promise.all([
        getJobDetailsFast(jobId, env).then((r) => r.data),
        loadDriversFromSheet().catch(() => []),
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stops: any[] = data?.stops ?? [];
      const pickup = stops.find((s) => s.stop_type_id === 1);
      const dropoff = stops.find((s) => s.stop_type_id === 2);
      const isPickup = !!pickup && !isCompletedOrRejectedStop(Number(pickup.stop_status_id));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nameOf = (s: any): string => s?.customer?.customer_name ?? s?.customer_name ?? "";
      await queueBypassLog([
        vnTimestamp(clickedAt),
        drivers.find((d) => d.driver_id === driver_id)?.name ?? "",
        driver_id,
        jobId,
        data?.reference_number ?? "",
        isPickup ? "Lấy mẫu" : "Giao mẫu",
        nameOf(isPickup ? pickup : dropoff),
        nameOf(pickup),
        nameOf(dropoff),
        vnTimestamp(new Date(out.until)),
      ]);
    } catch (e) {
      console.error("[geofence-bypass] log queue failed:", e instanceof Error ? e.message : e);
    }
  });

  return NextResponse.json({ success: true, until: out.until });
}
