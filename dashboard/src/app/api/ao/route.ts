import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, createJob, type Env } from "@/lib/cartrack";
import { vnDate, vnHoursMinutes, vnTimestamp } from "@/lib/time";
import { isActiveStop, JOB_STATUS, STOP_STATUS } from "@/lib/job-filters";
import { pushRunLog } from "@/lib/smart-log-kv";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

const D001_UUID = "3927b076-3af9-11ed-b939-506b8dbc8dfb";
const D010_UUID = "9a15e7a4-3d83-11ed-be4e-506b8dbc8dfb";

interface Vendor {
  name: string;
  uuid: string;
  dropoff_uuid: string;
  cutoff_hour?: number;
}

const VENDORS: Vendor[] = [
  {
    name: "Medic Karyotype",
    uuid: "49642318-38ae-11ed-91d5-506b8dbc8dfb",
    dropoff_uuid: D001_UUID,
  },
  {
    name: "Bệnh Viện Nhiệt Đới",
    uuid: "ce8fbd00-2439-11ee-8a2d-506b8d9879b5",
    dropoff_uuid: D001_UUID,
  },
  {
    name: "Trí Việt",
    uuid: "d81aa368-1210-11f1-9378-fa163ee8d8ac",
    dropoff_uuid: D001_UUID,
  },
  {
    name: "Trung tâm Pháp Y",
    uuid: "9ae5f732-1cbb-11ef-967b-506b8d9879b5",
    dropoff_uuid: D010_UUID,
    cutoff_hour: 12,
  },
  {
    name: "Bệnh Viện Da Liễu",
    uuid: "1bc194a8-1f47-11f1-9378-fa163ee8d8ac",
    dropoff_uuid: D001_UUID,
  },
  {
    name: "Thu Hồi Mẫu Bệnh Viện Bưu Điện",
    uuid: "be7d54b2-4d09-11f1-9378-fa163ee8d8ac",
    dropoff_uuid: D001_UUID,
  },
  {
    name: "Thu Hồi Mẫu Đại Học Y Dược",
    uuid: "51742f2e-1748-11ef-808b-506b8d9879b5",
    dropoff_uuid: D001_UUID,
  },
  {
    name: "Bệnh Viện Chợ Rẫy",
    uuid: "5c8efb94-38ad-11ed-b146-506b8dbc8dfb",
    dropoff_uuid: D001_UUID,
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
async function fetchAoJobsToday(from: string, to: string, env: Env): Promise<any[]> {
  const params = new URLSearchParams({
    "filter[create_ts_from]": from,
    "filter[create_ts_to]": to,
    "filter[reference_number]": "lay_ket_qua_hoac_thu_hoi_mau",
    limit: "100",
  });
  const res = await fetch(`${BASE_URL}/jobs?${params}`, {
    headers: getHeaders(env),
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.data ?? [];
}

// ── GET /api/ao?mode=orders — today's lay_ket_qua_hoac_thu_hoi_mau jobs ──────────────────────

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const mode = req.nextUrl.searchParams.get("mode");

  if (mode !== "orders") {
    return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
  }

  try {
    const today = vnDate();
    const jobs = await fetchAoJobsToday(`${today} 00:00:00`, `${today} 23:59:59`, env);

    const orders = jobs
      .filter((j) => j.job_status_id !== 3 && j.job_status_id !== 7)
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
          dropoff_status_id: dropoff?.stop_status_id ?? null,
          pickup_completed_ts: pickup?.activity_completed_ts?.slice(0, 19) ?? null,
          dropoff_started_ts:  dropoff?.activity_started_ts?.slice(0, 19) ?? null,
          dropoff_completed_ts: dropoff?.activity_completed_ts?.slice(0, 19) ?? null,
          create_ts: j.create_ts?.slice(0, 19) ?? null,
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
    const { vendor_uuid, note } = await req.json() as { vendor_uuid: string; note?: string | null };

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

    const todayJobs = await fetchAoJobsToday(todayStart, todayEnd, env);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const duplicate = todayJobs.find((job: any) => {
      if (job.job_status_id === 7 || job.job_status_id === 3) return false;
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
      stop_type_id: 1,
      customer_id:  vendor_uuid,
      duration:     5,
      note:         note || null,
      todos: [
        { todo_type_id: 2, description: "Chụp Hình Kết Quả", is_required: true },
      ],
    };

    let scheduleTypeId = 1;
    let scheduledDeliveryTs: string | undefined;

    if (vendor.cutoff_hour !== undefined) {
      const hh = vendor.cutoff_hour;
      const toStr   = `${String(hh).padStart(2, "0")}:00:00+07:00`;
      const fromStr = `${String(hh - 1).padStart(2, "0")}:00:00+07:00`;
      pickupStop.delivery_windows = [{ time_from: fromStr, time_to: toStr }];

      const { hours } = vnHoursMinutes();
      if (hours >= hh) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        scheduleTypeId       = 2;
        // Keep scheduled_delivery_ts on the delivery day but at day-start, NOT the cutoff
        // hour. scheduled_delivery_ts gates mobile-app visibility (is_visible=false while
        // now <= scheduled_delivery_ts), so a cutoff-hour value would hide the job from the
        // driver until that hour. Day-start keeps the date (so the engine still finds it
        // tomorrow) while staying visible all day; the window is carried by delivery_windows.
        scheduledDeliveryTs  = `${vnDate(tomorrow)} 00:00:00`;
      }
    }

    const jobPayload: Record<string, unknown> = {
      job_type_id:      1,
      schedule_type_id: scheduleTypeId,
      ...(scheduledDeliveryTs ? { scheduled_delivery_ts: scheduledDeliveryTs } : {}),
      reference_number: "lay_ket_qua_hoac_thu_hoi_mau",
      stops: [
        pickupStop,
        {
          stop_type_id: 2,
          customer_id:  vendor.dropoff_uuid,
          duration:     10,
          todos: [
            { todo_type_id: 5, description: "Tên Người Bàn Giao Kết Quả", is_required: true },
          ],
        },
      ],
    };

    const createRes = await createJob(jobPayload, env);

    if (!createRes.ok) {
      releaseLock(lockKey);
      return NextResponse.json({ error: "Failed to create job", details: createRes.body }, { status: createRes.status });
    }

    const created = createRes.body;
    const jobId = created.data?.job_id;
    void pushRunLog([{
      ts: vnTimestamp(),
      level: "OK",
      msg: `[AO] Tạo job lấy kết quả: Job ${jobId} | ${vendor.name}`,
    }]);
    return NextResponse.json({ success: true, job_id: jobId });
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
    void pushRunLog([{
      ts: vnTimestamp(),
      level: "OK",
      msg: `[AO] Huỷ job: Job ${jobId}`,
    }]);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
