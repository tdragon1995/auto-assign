import { NextRequest, NextResponse } from "next/server";
import { assignJob, deleteJob, BASE_URL, getHeaders, type Env } from "@/lib/cartrack";
import { vnDate } from "@/lib/time";
import { DIAG_LOCATIONS } from "@/lib/diag-locations";

// ── GET /api/cham-cong — location list OR driver shift state ──────────────

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const driverId = req.nextUrl.searchParams.get("driver_id");

  // ── Shift state for a specific driver ────────────────────────────────────
  if (driverId) {
    try {
      const headers = getHeaders(env);
      // Cartrack filters use GMT+7 (VN time) — pass VN date strings directly
      const today = vnDate();

      const res = await fetch(
        `${BASE_URL}/jobs?filter[driver_id]=${driverId}&filter[create_ts_from]=${today} 00:00:00&filter[create_ts_to]=${today} 23:59:59&limit=100`,
        { headers, cache: "no-store" }
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let todayJobs: any[] = [];
      if (res.ok) {
        const data = await res.json();
        todayJobs = data.data ?? [];
      }

      const chamCongJobs = todayJobs.filter(
        (j) =>
          (j.reference_number ?? "").startsWith("Chấm Công -") &&
          j.job_status_id !== 7 &&
          j.job_status_id !== 3
      );

      const checkInCount       = chamCongJobs.filter((j) => (j.labels ?? []).includes("check_in")).length;
      const completedCheckOuts = chamCongJobs.filter((j) => (j.labels ?? []).includes("check_out") && j.job_status_id === 5).length;
      const activeCheckOuts    = chamCongJobs.filter((j) => (j.labels ?? []).includes("check_out") && j.job_status_id !== 5).length;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pendingJobList = todayJobs.filter(
        (j: any) =>
          !(j.reference_number ?? "").startsWith("Chấm Công -") &&
          !(j.labels ?? []).some((l: string) => l === "check_in" || l === "check_out") &&
          j.job_status_id === 4
      );
      const pendingJobs = pendingJobList.length;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pendingJobNames: string[] = pendingJobList.map((j: any) => {
        const stops: any[] = j.stops ?? [];
        const pickup  = stops.find((s: any) => s.stop_type_id === 1);
        const dropoff = stops.find((s: any) => s.stop_type_id === 2);
        if (pickup && dropoff) return `${pickup.customer_name} → ${dropoff.customer_name}`;
        return pickup?.customer_name ?? dropoff?.customer_name ?? j.reference_number ?? `Job #${j.job_id}`;
      });

      return NextResponse.json({ checkInCount, completedCheckOuts, activeCheckOuts, pendingJobs, pendingJobNames });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }
  }

  // ── Location list ─────────────────────────────────────────────────────────
  return NextResponse.json({ pscs: DIAG_LOCATIONS });
}

// ── POST /api/cham-cong — create check-in or check-out job ────────────────

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const { driver_id, psc_customer_id, type } = await req.json();

    if (!driver_id || !psc_customer_id || (type !== "check-in" && type !== "check-out")) {
      return NextResponse.json({ error: "Missing or invalid fields" }, { status: 400 });
    }

    const isCheckin = type === "check-in";
    const jobPayload = {
      job_type_id: 3,
      schedule_type_id: 1,
      reference_number: `Chấm Công - ${isCheckin ? "Vào" : "Ra"}`,
      labels: [isCheckin ? "check_in" : "check_out"],
      stops: [
        {
          stop_type_id: 3,
          customer_id: psc_customer_id,
          duration: 5,
        },
      ],
    };

    const createRes = await fetch(`${BASE_URL}/jobs`, {
      method: "POST",
      headers: getHeaders(env),
      body: JSON.stringify(jobPayload),
    });

    if (!createRes.ok) {
      const errBody = await createRes.json().catch(() => ({}));
      return NextResponse.json({ error: "Failed to create job", details: errBody }, { status: createRes.status });
    }

    const created = await createRes.json();
    const jobId: number | undefined = created.data?.job_id;
    if (!jobId) return NextResponse.json({ error: "No job_id returned from Cartrack" }, { status: 500 });

    let assignResult = await assignJob(driver_id, jobId, env);
    for (let attempt = 1; attempt <= 2 && assignResult.status !== 200; attempt++) {
      assignResult = await assignJob(driver_id, jobId, env);
    }

    if (assignResult.status !== 200) {
      await deleteJob(jobId, env);
      return NextResponse.json(
        { error: "Tạo chấm công chưa thành công, vui lòng thử lại. Liên hệ điều phối nếu vẫn gặp lỗi!" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, job_id: jobId });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
