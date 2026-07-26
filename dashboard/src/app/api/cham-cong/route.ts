import { NextRequest, NextResponse } from "next/server";
import { createJob, deleteJob, getJobDetails, updateJobStops, getTimelineJobs, BASE_URL, getHeaders, isDriverUnavailableError, type Env } from "@/lib/cartrack";
import { vnDate } from "@/lib/time";
import { DIAG_LOCATIONS } from "@/lib/diag-locations";
import { isStopStarted } from "@/lib/job-filters";
import { acquireCreateLock, releaseCreateLock } from "@/lib/smart-log-kv";

const CHAM_CONG_PREFIX = "Chấm Công -";

interface OngoingChamCong {
  job_id: number;
  type: "check-in" | "check-out";
  customer_id: string | null;
  location_name: string | null;
}

type ChamCongState = "done" | "started" | "pending";

interface ChamCongTask {
  job_id: number;
  type: "check-in" | "check-out";
  customer_id: string | null;
  location_name: string | null;
  time: string | null; // HH:MM the driver tapped / finished
  state: ChamCongState;
  switchable: boolean; // pending (not started, not done) — the only editable state
}

/** "YYYY-MM-DD HH:MM:SS" or "…THH:MM…" → "HH:MM". Null for any other shape. */
function hhmm(ts: unknown): string | null {
  if (typeof ts !== "string" || ts.length < 16) return null;
  return ts.slice(11, 16);
}

/** All of today's chấm-công tasks for the driver, oldest first, each tagged with its
 *  state. `switchable` (not started, not done) mirrors the PATCH guard exactly — only
 *  those rows may change location; a started/finished stop is a real record. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildChamCongTasks(chamCongJobs: any[]): ChamCongTask[] {
  return chamCongJobs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((j: any): ChamCongTask => {
      const stop = (j.stops ?? [])[0] ?? {};
      const customerId: string | null = stop.customer_id ?? null;
      const done = j.job_status_id === 5;
      const started = !done && isStopStarted(stop);
      const state: ChamCongState = done ? "done" : started ? "started" : "pending";
      const timeSrc = done
        ? (stop.activity_completed_ts ?? j.create_ts)
        : started
          ? (stop.activity_started_ts ?? j.create_ts)
          : (j.create_ts ?? j.scheduled_delivery_ts);
      return {
        job_id: Number(j.job_id),
        type: labelNames(j.labels).includes("check_out") ? "check-out" : "check-in",
        customer_id: customerId,
        location_name:
          DIAG_LOCATIONS.find((l) => l.customer_id === customerId)?.name ??
          DIAG_LOCATIONS.find((l) => l.customer_name === stop.customer_name)?.name ??
          stop.customer_name ??
          null,
        time: hhmm(timeSrc),
        state,
        switchable: state === "pending",
      };
    })
    .sort((a, b) => a.job_id - b.job_id);
}

/** Stop labels arrive in two shapes: plain strings from REST (`["check_in"]`) but
 *  objects from JSON-RPC (`[{ labelId, label: "check_in" }]`). Normalise to strings. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function labelNames(labels: any): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((l) => (typeof l === "string" ? l : l?.label))
    .filter((l): l is string => typeof l === "string");
}

/** Today's jobs for one driver. The route-timeline (JSON-RPC) is the primary source:
 *  measured against prod it returns the whole day in ~2.2s, where the driver-scoped
 *  REST list averaged ~6s and spiked past 10s — scoping REST to one driver does not
 *  make it fast. The timeline also carries stop_id / stop_status_id / activity_*, so
 *  the started-check has a trustworthy source (the REST *list* does not reliably).
 *
 *  Falls back to REST when the timeline is unavailable (UAT, or no fleetweb cookie —
 *  it fails silently, so this must degrade rather than error).
 *
 *  Note the filter basis differs: the timeline is keyed on scheduled_delivery_ts, the
 *  REST fallback on create_ts. For chấm-công jobs the two are the same instant (created
 *  and scheduled on the spot), so the counts agree either way. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadDriverJobsToday(driverId: string, today: string, env: Env): Promise<any[]> {
  try {
    const jobs = await getTimelineJobs(today, env);
    if (jobs) return jobs.filter((j) => j.delivery_driver_id === driverId);
  } catch {
    /* fall through to REST */
  }

  const res = await fetch(
    `${BASE_URL}/jobs?filter[driver_id]=${driverId}&filter[create_ts_from]=${today} 00:00:00&filter[create_ts_to]=${today} 23:59:59&limit=100`,
    { headers: getHeaders(env), cache: "no-store" }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.data ?? [];
}

/** The driver's chấm-công task whose location can still be corrected: today's newest
 *  one they haven't touched yet in the Cartrack app. Once a stop is started the record
 *  is real and only điều phối should move it — PATCH re-checks this against fresh job
 *  details rather than trusting the client. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findSwitchableChamCong(chamCongJobs: any[]): OngoingChamCong | null {
  const job = chamCongJobs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((j: any) => {
      if (j.job_status_id === 5) return false; // completed — the record is real now
      const stop = (j.stops ?? [])[0];
      return stop && !isStopStarted(stop);
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .sort((a: any, b: any) => Number(b.job_id) - Number(a.job_id))[0];

  if (!job) return null;
  const stop = (job.stops ?? [])[0];
  const customerId: string | null = stop?.customer_id ?? null;

  return {
    job_id: Number(job.job_id),
    type: labelNames(job.labels).includes("check_out") ? "check-out" : "check-in",
    customer_id: customerId,
    location_name:
      DIAG_LOCATIONS.find((l) => l.customer_id === customerId)?.name ??
      DIAG_LOCATIONS.find((l) => l.customer_name === stop?.customer_name)?.name ??
      stop?.customer_name ??
      null,
  };
}

// ── GET /api/cham-cong — location list OR driver shift state ──────────────

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const driverId = req.nextUrl.searchParams.get("driver_id");

  // ── Shift state for a specific driver ────────────────────────────────────
  if (driverId) {
    try {
      // Cartrack filters use GMT+7 (VN time) — pass VN date strings directly
      const today = vnDate();

      const todayJobs = await loadDriverJobsToday(driverId, today, env);

      const chamCongJobs = todayJobs.filter(
        (j) =>
          (j.reference_number ?? "").startsWith(CHAM_CONG_PREFIX) &&
          j.job_status_id !== 7 &&
          j.job_status_id !== 3
      );

      const ongoing = findSwitchableChamCong(chamCongJobs);
      const tasks = buildChamCongTasks(chamCongJobs);

      const checkInCount       = chamCongJobs.filter((j) => labelNames(j.labels).includes("check_in")).length;
      const completedCheckOuts = chamCongJobs.filter((j) => labelNames(j.labels).includes("check_out") && j.job_status_id === 5).length;
      const activeCheckOuts    = chamCongJobs.filter((j) => labelNames(j.labels).includes("check_out") && j.job_status_id !== 5).length;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pendingJobList = todayJobs.filter(
        (j: any) =>
          !(j.reference_number ?? "").startsWith(CHAM_CONG_PREFIX) &&
          !labelNames(j.labels).some((l: string) => l === "check_in" || l === "check_out") &&
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

      return NextResponse.json({ checkInCount, completedCheckOuts, activeCheckOuts, pendingJobs, pendingJobNames, ongoing, tasks });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }
  }

  // ── Location list ─────────────────────────────────────────────────────────
  return NextResponse.json({ pscs: DIAG_LOCATIONS });
}

// ── PATCH /api/cham-cong — move an open chấm-công job to another location ──
// The driver picked the wrong địa điểm. Rewrite the stop on the existing job rather
// than delete-and-recreate, so the original check-in time survives the correction.

export async function PATCH(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const { driver_id, job_id, psc_customer_id } = await req.json();

    const jobId = Number(job_id);
    if (!driver_id || !Number.isInteger(jobId) || jobId <= 0 || !psc_customer_id) {
      return NextResponse.json({ error: "Thiếu thông tin để đổi địa điểm" }, { status: 400 });
    }

    const psc = DIAG_LOCATIONS.find((l) => l.customer_id === psc_customer_id);
    if (!psc) {
      return NextResponse.json({ error: "Địa điểm không hợp lệ" }, { status: 400 });
    }

    // Re-read from Cartrack: the client's view can be minutes stale, and the driver
    // may have started the stop in the app since the list was fetched.
    const details = await getJobDetails(jobId, env);
    const data = details.data;
    if (!data?.job_id) {
      return NextResponse.json({ error: "Không tìm thấy task chấm công" }, { status: 404 });
    }

    if (!(data.reference_number ?? "").startsWith(CHAM_CONG_PREFIX)) {
      return NextResponse.json({ error: "Task này không phải task chấm công" }, { status: 409 });
    }

    // Don't let one driver move another driver's job.
    if (data.delivery_driver_id !== driver_id) {
      return NextResponse.json({ error: "Task này không thuộc về bạn" }, { status: 403 });
    }

    if (data.job_status_id === 5 || data.job_status_id === 3 || data.job_status_id === 7) {
      return NextResponse.json(
        { error: "Task đã kết thúc, không thể đổi địa điểm. Vui lòng liên hệ điều phối!" },
        { status: 409 }
      );
    }

    const stop = (data.stops ?? [])[0];
    if (!stop?.stop_id) {
      return NextResponse.json({ error: "Task không có địa điểm để đổi" }, { status: 409 });
    }

    if (isStopStarted(stop)) {
      return NextResponse.json(
        { error: "Bạn đã bắt đầu task này trên app Cartrack, không thể đổi địa điểm. Vui lòng liên hệ điều phối!" },
        { status: 409 }
      );
    }

    if (stop.customer_id === psc.customer_id) {
      return NextResponse.json({ error: `Task đang ở ${psc.name} rồi.` }, { status: 409 });
    }

    // job_type_id is required here — a chấm-công job has a single stop, and without it
    // Cartrack validates against the default 2-stop shape and 422s. Send the job's own
    // type rather than assuming 3.
    const putRes = await updateJobStops(
      jobId,
      [{
        stop_id: Number(stop.stop_id),
        stop_type_id: Number(stop.stop_type_id ?? 3),
        customer_id: psc.customer_id,
        customer_name: psc.customer_name,
      }],
      env,
      Number(data.job_type_id ?? 3)
    );
    if (!putRes.ok) {
      return NextResponse.json(
        { error: "Đổi địa điểm thất bại, vui lòng thử lại.", status: putRes.status, details: putRes.body },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true, job_id: jobId, location_name: psc.name });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── POST /api/cham-cong — create check-in or check-out job ────────────────

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  let lockKey: string | null = null;

  try {
    const { driver_id, psc_customer_id, type } = await req.json();

    if (!driver_id || !psc_customer_id || (type !== "check-in" && type !== "check-out")) {
      return NextResponse.json({ error: "Missing or invalid fields" }, { status: 400 });
    }

    // Cross-instance guard against a double-tap creating duplicate chấm-công jobs (the
    // POST has no other dedup). Keyed per driver + type + day; held to its TTL on success,
    // released on failure.
    lockKey = `chamcong:${driver_id}-${type}-${vnDate()}`;
    if (!(await acquireCreateLock(lockKey))) {
      return NextResponse.json(
        { error: "duplicate", message: "Đang xử lý chấm công, vui lòng đợi." },
        { status: 409 }
      );
    }

    const isCheckin = type === "check-in";
    const jobPayload = {
      job_type_id: 3,
      schedule_type_id: 1,
      reference_number: `Chấm Công - ${isCheckin ? "Vào" : "Ra"}`,
      labels: [isCheckin ? "check_in" : "check_out"],
      delivery_driver_id: driver_id, // assign at creation — single call (Cartrack returns job_status_id 4)
      stops: [
        {
          stop_type_id: 3,
          customer_id: psc_customer_id,
          duration: 5,
        },
      ],
    };

    const tCreate = Date.now();
    const createRes = await createJob(jobPayload, env);
    console.log(`[cham-cong] create via=${createRes.via} ok=${createRes.ok} ${Date.now() - tCreate}ms`);

    if (!createRes.ok) {
      void releaseCreateLock(lockKey);
      const errBody = createRes.body;
      if (isDriverUnavailableError(errBody)) {
        return NextResponse.json(
          { error: 'Nhân viên đang ở trạng thái "Nghỉ ngơi": Cần cập nhật trạng thái và thử lại!' },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: "Failed to create job", details: errBody }, { status: createRes.status });
    }

    const created = createRes.body;
    const jobId: number | undefined = created.data?.job_id;
    if (!jobId) {
      void releaseCreateLock(lockKey);
      return NextResponse.json({ error: "No job_id returned from Cartrack" }, { status: 500 });
    }

    // Defensive: a 200 can still come back unassigned (status 4 ≠ driver set). Verify, else roll back.
    if (created.data?.delivery_driver_id !== driver_id) {
      await deleteJob(jobId, env);
      void releaseCreateLock(lockKey);
      return NextResponse.json(
        { error: "Tạo chấm công chưa thành công, vui lòng thử lại. Liên hệ điều phối nếu vẫn gặp lỗi!" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, job_id: jobId });
  } catch (e) {
    if (lockKey) void releaseCreateLock(lockKey);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
