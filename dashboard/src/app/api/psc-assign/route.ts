import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, type Env } from "@/lib/cartrack";
import { vnDate, vnHoursMinutes } from "@/lib/time";
import { isActiveStop } from "@/lib/job-filters";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

// In-memory dedup lock: prevents race condition when two tabs submit within seconds of each other.
// Key = `${pickup}-${dropoff}-${today}`, value = timestamp when lock was set.
// Lock expires after 15s — long enough to cover Cartrack job creation + indexing delay.
const creationLock = new Map<string, number>();
const LOCK_TTL_MS = 15_000;

function acquireLock(key: string): boolean {
  const ts = creationLock.get(key);
  if (ts !== undefined && Date.now() - ts < LOCK_TTL_MS) return false;
  creationLock.set(key, Date.now());
  return true;
}

function releaseLock(key: string): void {
  creationLock.delete(key);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchJobsToday(status: number, from: string, to: string, env: Env): Promise<any[]> {
  const params = new URLSearchParams({
    "filter[create_ts_from]": from,
    "filter[create_ts_to]": to,
    "filter[job_status_id]": String(status),
    limit: "1000",
  });

  const res = await fetch(`${BASE_URL}/jobs?${params}`, {
    headers: getHeaders(env),
    cache: "no-store",
  });

  if (!res.ok) return [];
  const data = await res.json();
  return data.data ?? [];
}

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  let lockKey: string | null = null;

  try {
    const body = await req.json();
    const { psc_pickup, dropoff_location, pickup, dropoff } = body;

    if (!pickup || !dropoff || !psc_pickup) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const today = vnDate();
    lockKey = `${pickup}-${dropoff}-${today}`;

    if (!acquireLock(lockKey)) {
      return NextResponse.json(
        { error: "duplicate", message: "Yêu cầu cùng chi nhánh đang được tạo!" },
        { status: 409 }
      );
    }

    // --- Duplicate check ---
    // Cartrack filters are GMT+7 — use VN date strings directly
    const todayStart = `${today} 00:00:00`;
    const todayEnd   = `${today} 23:59:59`;

    // Fetch Assign Later (2) and Assigned (4) in parallel — only statuses that can block re-booking
    const [unassignedJobs, assignedJobs] = await Promise.all([
      fetchJobsToday(2, todayStart, todayEnd, env),
      fetchJobsToday(4, todayStart, todayEnd, env),
    ]);
    const allJobs = [...unassignedJobs, ...assignedJobs];

    // Block if pickup stop is active (Created/En Route/Arrived) AND job is not cancelled
    // Allow re-booking once pickup stop is Completed (4) or Rejected (5), or job was cancelled
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const duplicate = allJobs.find((job: any) => {
      if (job.job_status_id === 7 || job.job_status_id === 3) return false;
      const stops = job.stops ?? [];
      const hasActivePickup = stops.some((s: any) =>
        s.stop_type_id === 1 &&
        s.customer_id === pickup &&
        isActiveStop(s.stop_status_id)
      );
      const hasMatchingDropoff = stops.some((s: any) =>
        s.stop_type_id === 2 &&
        s.customer_id === dropoff
      );
      return hasActivePickup && hasMatchingDropoff;
    });

    if (duplicate) {
      releaseLock(lockKey);
      return NextResponse.json(
        {
          error: "duplicate",
          message: `A job for this pickup already exists today (Job #${duplicate.job_id})`,
          job_id: duplicate.job_id,
          reference_number: duplicate.reference_number ?? null,
        },
        { status: 409 }
      );
    }

    // --- Create the job ---
    // Always generate timestamp-based reference (ignore ref_number from config — Cartrack strips emoji)
    const { hours, minutes } = vnHoursMinutes();
    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    const refLabel = `${psc_pickup.replace(/^BRA\s*-\s*/i, "")}→${dropoff_location.replace(/^BRA\s*-\s*/i, "")}_${hh}:${mm}`;

    const jobPayload = {
      job_type_id: 1,
      schedule_type_id: 1,
      reference_number: refLabel,
      labels: ["🛵 Vận chuyển mẫu PSC"],
      stops: [
        {
          stop_type_id: 1,
          customer_id: pickup,
          duration: 5,
          todos: [
            { todo_type_id: 2, description: "📦 Chụp thấy rõ mẫu đã đóng gói trong hộp" },
            { todo_type_id: 2, description: "✍️ Chụp batchsheet đã ký" },
          ],
        },
        {
          stop_type_id: 2,
          customer_id: dropoff,
          duration: 10,
          todos: [
            { todo_type_id: 2, description: "📋 Chụp các hộp thấy rõ batchsheet" },
            { todo_type_id: 2, description: "🤝 Chụp phiếu bàn giao & hàng mang về" },
          ],
        },
      ],
      items: [
        {
          description: "🧪 Mẫu",
          weight: 0,
          item_type_id: 1,
          quantity: 1,
          tracking_number: "",
          todos: [
            { todo_type_id: 3, stop_type_id: 1, is_required: true, description: "🔍 Quét mọi batchsheet" },
            { todo_type_id: 5, stop_type_id: 2, is_required: true, description: "👤 Người nhận" },
          ],
        },
      ],
    };

    const createRes = await fetch(`${BASE_URL}/jobs`, {
      method: "POST",
      headers: getHeaders(env),
      body: JSON.stringify(jobPayload),
    });

    if (!createRes.ok) {
      releaseLock(lockKey);
      const errBody = await createRes.json().catch(() => ({}));
      return NextResponse.json({ error: "Failed to create job", details: errBody }, { status: createRes.status });
    }

    const created = await createRes.json();

    return NextResponse.json({
      success: true,
      reference: refLabel,
      job_id: created.data?.job_id,
    });
  } catch (e) {
    if (lockKey) releaseLock(lockKey);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
