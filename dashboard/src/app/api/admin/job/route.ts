import { NextRequest, NextResponse } from "next/server";
import { getJobDetailsFast, type Env } from "@/lib/cartrack";
import { isStopStarted } from "@/lib/job-filters";
import { sbSelect, supabaseConfigured } from "@/lib/supabase-rest";
import type { RideHailTrip } from "@/lib/ride-hail";

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
    // The ride-hail record rides along so its amount can be edited here later. A
    // Supabase hiccup must never cost the lookup itself: it reads as "no record".
    const [details, rideHail] = await Promise.all([
      getJobDetailsFast(jobId, env),
      supabaseConfigured()
        ? sbSelect<RideHailTrip>("ride_hail_trips", `select=job_id,provider,amount_vnd,waybill,admin_name,completed_at&job_id=eq.${jobId}`)
            .then((r) => r[0] ?? null).catch(() => null)
        : null,
    ]);
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

    // Cartrack leaves the denormalized stop.customer_name stale after a dropoff swap;
    // the nested customer object is resolved live, so prefer it for display.
    return NextResponse.json({
      job_id: data.job_id,
      job_status_id: data.job_status_id ?? null,
      reference_number: data.reference_number ?? null,
      delivery_driver_id: data.delivery_driver_id ?? null,
      pickup: pickup
        ? {
            stop_id: pickup.stop_id ?? null,
            customer_id: pickup.customer?.customer_id ?? pickup.customer_id ?? null,
            customer_name: pickup.customer?.customer_name ?? pickup.customer_name ?? null,
          }
        : null,
      dropoff: dropoff
        ? {
            stop_id: dropoff.stop_id ?? null,
            customer_id: dropoff.customer?.customer_id ?? dropoff.customer_id ?? null,
            customer_name: dropoff.customer?.customer_name ?? dropoff.customer_name ?? null,
          }
        : null,
      started: stops.some((s) => isStopStarted(s)),
      ride_hail: rideHail,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
