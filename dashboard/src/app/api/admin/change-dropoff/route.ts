import { NextRequest, NextResponse } from "next/server";
import { getJobDetails, updateJobStops, type Env } from "@/lib/cartrack";
import { JOB_STATUS } from "@/lib/job-filters";
import { DIAG_LOCATIONS } from "@/lib/diag-locations";

// ── POST /api/admin/change-dropoff — redirect a job's dropoff to another PSC ─
// Body: { job_id, new_dropoff_customer_id, job_status_id?, pickup_stop_id?, pickup_customer_id?, dropoff_stop_id? }
// If the optional stop fields are provided (client passes back what it got from the lookup),
// we skip the getJobDetails round-trip and go straight to updateJobStops (1 call vs 2).

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const {
      job_id,
      new_dropoff_customer_id,
      job_status_id: clientStatusId,
      pickup_stop_id,
      pickup_customer_id,
      dropoff_stop_id,
    } = await req.json();

    const jobId = Number(job_id);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return NextResponse.json({ error: "Job ID không hợp lệ" }, { status: 400 });
    }

    const psc = DIAG_LOCATIONS.find((l) => l.customer_id === new_dropoff_customer_id);
    if (!psc) {
      return NextResponse.json({ error: "Điểm giao không hợp lệ" }, { status: 400 });
    }

    // Fast path: client provided all stop data from its earlier lookup — skip getJobDetails.
    if (
      pickup_stop_id != null &&
      pickup_customer_id != null &&
      dropoff_stop_id != null &&
      clientStatusId != null
    ) {
      const statusId = Number(clientStatusId);
      if (statusId === 5 || statusId === 3 || statusId === 7) {
        const label = JOB_STATUS[statusId] ?? "đã kết thúc";
        return NextResponse.json(
          { error: `Không thể đổi điểm giao: job ${label.toLowerCase()}` },
          { status: 409 }
        );
      }

      const updatedStops = [
        { stop_id: Number(pickup_stop_id), stop_type_id: 1, customer_id: String(pickup_customer_id) },
        { stop_id: Number(dropoff_stop_id), stop_type_id: 2, customer_id: psc.customer_id },
      ];

      const putRes = await updateJobStops(jobId, updatedStops, env);
      if (!putRes.ok) {
        return NextResponse.json(
          { error: "Đổi điểm giao thất bại", status: putRes.status, details: putRes.body },
          { status: 502 }
        );
      }
      return NextResponse.json({ success: true, job_id: jobId, dropoff_name: psc.name });
    }

    // Fallback: fetch from Cartrack (e.g. called without stop metadata).
    const details = await getJobDetails(jobId, env);
    const data = details.data;
    if (!data?.job_id) {
      return NextResponse.json({ error: "Không tìm thấy job" }, { status: 404 });
    }

    const statusId: number | null = data.job_status_id ?? null;
    if (statusId === 5 || statusId === 3 || statusId === 7) {
      const label = JOB_STATUS[statusId] ?? "đã kết thúc";
      return NextResponse.json(
        { error: `Không thể đổi điểm giao: job ${label.toLowerCase()}` },
        { status: 409 }
      );
    }

    const rawStops = (data.stops ?? []) as {
      stop_id?: number;
      stop_type_id?: number;
      customer_id?: string;
    }[];
    const updatedStops = rawStops
      .filter((s) => s.stop_id && s.stop_type_id && s.customer_id)
      .map((s) => ({
        stop_id: s.stop_id!,
        stop_type_id: s.stop_type_id!,
        customer_id: s.stop_type_id === 2 ? psc.customer_id : s.customer_id!,
      }));

    if (updatedStops.length < 2 || !updatedStops.some((s) => s.stop_type_id === 2)) {
      return NextResponse.json({ error: "Job không có điểm giao để đổi" }, { status: 409 });
    }

    const putRes = await updateJobStops(jobId, updatedStops, env);
    if (!putRes.ok) {
      return NextResponse.json(
        { error: "Đổi điểm giao thất bại", status: putRes.status, details: putRes.body },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true, job_id: jobId, dropoff_name: psc.name });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
