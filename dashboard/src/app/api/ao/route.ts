import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, type Env } from "@/lib/cartrack";
import { vnDate, vnTimestamp } from "@/lib/time";
import { isActiveStop, JOB_STATUS, STOP_STATUS } from "@/lib/job-filters";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

const D001_UUID = "3927b076-3af9-11ed-b939-506b8dbc8dfb";
const D010_UUID = "9a15e7a4-3d83-11ed-be4e-506b8dbc8dfb";

interface Vendor {
  name: string;
  uuid: string;
  dropoff_uuid: string;
  dropoff_name: string;
  cutoff_hour?: number;
}

const VENDORS: Vendor[] = [
  {
    name: "Bệnh Viện Da Liễu",
    uuid: "1bc194a8-1f47-11f1-9378-fa163ee8d8ac",
    dropoff_uuid: D001_UUID,
    dropoff_name: "BRA - D001",
  },
  {
    name: "Bệnh Viện Chợ Rẫy",
    uuid: "5c8efb94-38ad-11ed-b146-506b8dbc8dfb",
    dropoff_uuid: D001_UUID,
    dropoff_name: "BRA - D001",
  },
  {
    name: "Trung tâm Pháp Y",
    uuid: "9ae5f732-1cbb-11ef-967b-506b8d9879b5",
    dropoff_uuid: D010_UUID,
    dropoff_name: "BRA - D010",
    cutoff_hour: 12,
  },
];

const VENDOR_BY_UUID = new Map(VENDORS.map((v) => [v.uuid, v]));

// In-memory dedup lock: prevents race condition when two tabs submit within seconds.
// Lock expires after 15s — enough to cover Cartrack job creation + indexing delay.
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

// ── GET /api/ao?mode=orders — today's ao_hard_copy jobs ──────────────────────

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const mode = req.nextUrl.searchParams.get("mode");

  if (mode !== "orders") {
    return NextResponse.json({
      vendors: VENDORS.map((v) => ({ name: v.name, uuid: v.uuid, dropoff_name: v.dropoff_name, cutoff_hour: v.cutoff_hour ?? null })),
    });
  }

  try {
    const today = vnDate();
    const params = new URLSearchParams({
      "filter[create_ts_from]": `${today} 00:00:00`,
      "filter[create_ts_to]": `${today} 23:59:59`,
      limit: "1000",
    });

    const res = await fetch(`${BASE_URL}/jobs?${params}`, {
      headers: getHeaders(env),
      cache: "no-store",
    });

    if (!res.ok) return NextResponse.json({ orders: [] });

    const data = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobs: any[] = data.data ?? [];

    const orders = jobs
      .filter((j) => j.reference_number === "ao_hard_copy" && j.job_status_id !== 3 && j.job_status_id !== 7)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((j) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stops: any[] = j.stops ?? [];
        const pickup  = stops.find((s: any) => s.stop_type_id === 1);
        const dropoff = stops.find((s: any) => s.stop_type_id === 2);
        return {
          job_id:           j.job_id,
          job_status:       JOB_STATUS[j.job_status_id] ?? "Không rõ",
          vendor_name:      VENDOR_BY_UUID.get(pickup?.customer_id)?.name ?? pickup?.customer_name ?? "—",
          pickup_stop_id:   pickup?.stop_id ?? null,
          pickup_status_id: pickup?.stop_status_id ?? null,
          dropoff_name:     dropoff?.customer_name ?? "—",
          dropoff_status:   STOP_STATUS[dropoff?.stop_status_id]?.label ?? "—",
          dropoff_color:    STOP_STATUS[dropoff?.stop_status_id]?.color ?? "slate",
          dropoff_update_ts: (
            dropoff?.activity_completed_ts ??
            dropoff?.activity_arrived_ts ??
            dropoff?.activity_started_ts ??
            null
          ),
        };
      });

    return NextResponse.json({ orders });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── POST /api/ao — create hard-copy retrieval job ─────────────────────────────

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  let lockKey: string | null = null;

  try {
    const { vendor_uuid } = await req.json();

    if (!vendor_uuid) {
      return NextResponse.json({ error: "Missing vendor_uuid" }, { status: 400 });
    }

    const vendor = VENDOR_BY_UUID.get(vendor_uuid);
    if (!vendor) {
      return NextResponse.json({ error: "Unknown vendor" }, { status: 400 });
    }

    const today = vnDate();
    lockKey = `ao-${vendor_uuid}-${today}`;

    if (!acquireLock(lockKey)) {
      return NextResponse.json(
        { error: "duplicate", message: "Yêu cầu cùng nhà cung cấp đang được tạo!" },
        { status: 409 }
      );
    }

    // Duplicate check: block if an active job with same pickup→dropoff exists today
    const todayStart = `${today} 00:00:00`;
    const todayEnd   = `${today} 23:59:59`;

    const [unassignedJobs, assignedJobs] = await Promise.all([
      fetchJobsToday(2, todayStart, todayEnd, env),
      fetchJobsToday(4, todayStart, todayEnd, env),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const duplicate = [...unassignedJobs, ...assignedJobs].find((job: any) => {
      if (job.job_status_id === 7 || job.job_status_id === 3) return false;
      if (job.reference_number !== "ao_hard_copy") return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stops: any[] = job.stops ?? [];
      const hasActivePickup    = stops.some((s: any) => s.stop_type_id === 1 && s.customer_id === vendor_uuid && isActiveStop(s.stop_status_id));
      const hasMatchingDropoff = stops.some((s: any) => s.stop_type_id === 2 && s.customer_id === vendor.dropoff_uuid);
      return hasActivePickup && hasMatchingDropoff;
    });

    if (duplicate) {
      releaseLock(lockKey);
      return NextResponse.json(
        {
          error: "duplicate",
          message: `Đã có yêu cầu cho nhà cung cấp này hôm nay (Job #${duplicate.job_id})`,
          job_id: duplicate.job_id,
        },
        { status: 409 }
      );
    }

    // Pháp Y pickup gets a 12:00 deadline window; dropoff has no window constraint
    const pickupStop: Record<string, unknown> = {
      stop_type_id:  1,
      customer_id:   vendor_uuid,
      customer_name: vendor.name,
      duration:      5,
      todos: [
        { todo_type_id: 2, description: "Chụp Hình Kết Quả", is_required: true },
      ],
    };

    if (vendor.cutoff_hour !== undefined) {
      const hh = `${String(vendor.cutoff_hour).padStart(2, "0")}:00:00+07:00`;
      pickupStop.delivery_windows = [{ time_from: hh, time_to: hh }];
    }

    const jobPayload = {
      job_type_id:           1,
      schedule_type_id:      2,
      scheduled_delivery_ts: vnTimestamp(),
      reference_number:      "ao_hard_copy",
      stops: [
        pickupStop,
        {
          stop_type_id:  2,
          customer_id:   vendor.dropoff_uuid,
          customer_name: vendor.dropoff_name,
          duration:      10,
          todos: [
            { todo_type_id: 5, description: "Tên Người Bàn Giao Kết Quả", is_required: true },
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
    return NextResponse.json({ success: true, job_id: created.data?.job_id });
  } catch (e) {
    if (lockKey) releaseLock(lockKey);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── DELETE /api/ao?job_id=123 — cancel job (only if pickup not started) ───────

export async function DELETE(req: NextRequest) {
  const env    = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const jobId  = req.nextUrl.searchParams.get("job_id");

  if (!jobId) return NextResponse.json({ error: "Missing job_id" }, { status: 400 });

  try {
    const headers = getHeaders(env);

    const jobRes = await fetch(`${BASE_URL}/jobs/${jobId}`, { headers, cache: "no-store" });
    if (!jobRes.ok) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const jobData = await jobRes.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickup = (jobData.data?.stops ?? []).find((s: any) => s.stop_type_id === 1);
    if (pickup && pickup.stop_status_id !== 1) {
      return NextResponse.json({ error: "Không thể huỷ: tài xế đã bắt đầu công việc." }, { status: 409 });
    }

    const res = await fetch(`${BASE_URL}/jobs/${jobId}?force=true`, { method: "DELETE", headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json({ error: "Failed to cancel job", details: err }, { status: res.status });
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
