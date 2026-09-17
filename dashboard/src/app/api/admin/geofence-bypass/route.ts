import { NextRequest, NextResponse } from "next/server";
import { getJobDetails, type Env } from "@/lib/cartrack";
import { loadDriversFromSheet } from "@/lib/config";
import { openGeofence } from "@/lib/geofence-bypass";
import { isCompletedOrRejectedStop } from "@/lib/job-filters";
import { appendGeofenceLog } from "@/lib/sheets-writer";
import { vnTimestamp } from "@/lib/time";

// ── POST /api/admin/geofence-bypass — let a job's driver complete stops off-site for 5 min ──
// Body: { job_id }. The driver comes from the live job, not the client. The assign cron
// restores enforcement. Every use is appended to the "Mở Geofence Log" tab as Lấy mẫu
// (pickup stop not yet completed) or Giao mẫu.

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const { job_id } = await req.json().catch(() => ({}));
  const jobId = Number(job_id);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: "Job ID không hợp lệ" }, { status: 400 });
  }

  const data = (await getJobDetails(jobId, env)).data;
  if (!data?.job_id) return NextResponse.json({ error: "Không tìm thấy job" }, { status: 404 });
  const driverId: string | null = data.delivery_driver_id ?? null;
  if (!driverId) return NextResponse.json({ error: "Job chưa giao cho tài xế" }, { status: 409 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stops: any[] = data.stops ?? [];
  const pickup = stops.find((s) => s.stop_type_id === 1);
  const dropoff = stops.find((s) => s.stop_type_id === 2);
  const stage = pickup && !isCompletedOrRejectedStop(Number(pickup.stop_status_id)) ? "pickup" : "dropoff";

  const out = await openGeofence(driverId, env);
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: 502 });

  // The geofence is already open — a failed record must not turn that into an error.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nameOf = (s: any): string => s?.customer?.customer_name ?? s?.customer_name ?? "";
  let warning: string | undefined;
  try {
    const drivers = await loadDriversFromSheet().catch(() => []);
    await appendGeofenceLog([
      vnTimestamp(),
      drivers.find((d) => d.driver_id === driverId)?.name ?? "",
      driverId,
      jobId,
      data.reference_number ?? "",
      stage === "pickup" ? "Lấy mẫu" : "Giao mẫu",
      nameOf(stage === "pickup" ? pickup : dropoff),
      nameOf(pickup),
      nameOf(dropoff),
      vnTimestamp(new Date(out.until)),
    ]);
  } catch (e) {
    console.error("[geofence-bypass] sheet log failed:", e instanceof Error ? e.message : e);
    warning = "Đã mở geofence nhưng không lưu được vào Google Sheet";
  }
  return NextResponse.json({ success: true, until: out.until, stage, warning });
}
