import { NextRequest, NextResponse } from "next/server";
import { createJob, type Env } from "@/lib/cartrack";
import { vnDate, vnHoursMinutes } from "@/lib/time";
import { acquireCreateLock, releaseCreateLock } from "@/lib/smart-log-kv";
import { notifyAdminGroup } from "@/lib/zalo";
import { NDTP_DROPOFFS, NDTP_PICKUP } from "@/lib/ndtp";
import { locationJobs } from "@/lib/day-snapshot";
import { proxyKind } from "@/lib/proxy-drivers";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

export interface NdtpTrip {
  job_id: number;
  dropoff_name: string;
  job_status_id: number | null;
  pickup_status_id: number | null;
  dropoff_status_id: number | null;
  driver_name: string | null;
  parked: boolean;
  requested_ts: string | null;
  pickup_completed_ts: string | null;
  dropoff_started_ts: string | null;
  dropoff_completed_ts: string | null;
}

// GET /api/ndtp — today's trips picked up at NĐTP, whoever booked them. Reads the day
// the assign cron already publishes (same source as the /qr feeds), so a load normally
// costs a Redis read and no Cartrack call; up to ~5 minutes behind.
export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const jobs = await locationJobs(vnDate(), env, NDTP_PICKUP.customer_id).catch(() => null);
  if (!jobs) return NextResponse.json({ error: "Chưa tải được danh sách chuyến" }, { status: 503 });

  const trips: NdtpTrip[] = [];
  for (const j of jobs) {
    // Cancelled and rejected trips are dispatch's business. A plan slot with NO driver is a
    // daily placeholder, not a trip — but NĐTP's scheduled runs ARE plan jobs, so unlike
    // /qr a plan job with a driver stays: it is the hospital's real morning pickup.
    if (![2, 4, 5].includes(j.job_status_id ?? 0)) continue;
    if (j.last_assigned_plan_id != null && !j.delivery_driver_id && j.job_status_id !== 5) continue;
    const pickup = j.stops.find((s) => s.stop_type_id === 1 && s.customer_id === NDTP_PICKUP.customer_id);
    if (!pickup) continue; // a trip only DELIVERING here
    const dropoff = j.stops.find((s) => s.stop_type_id === 2);
    const kind = proxyKind(j.driver.last_name, j.delivery_driver_id);
    trips.push({
      job_id: j.job_id,
      dropoff_name: dropoff?.customer_name ?? "—",
      job_status_id: j.job_status_id ?? null,
      pickup_status_id: pickup.stop_status_id ?? null,
      dropoff_status_id: dropoff?.stop_status_id ?? null,
      driver_name: kind ? null : j.driver.last_name,
      parked: kind === "queue" || kind === "reject",
      // The unrouted pool writes "T", the timeline a space; one shape sorts and slices.
      requested_ts: j.scheduled_delivery_ts?.replace("T", " ").slice(0, 19) ?? null,
      pickup_completed_ts: pickup.activity_completed_ts,
      dropoff_started_ts: dropoff?.activity_started_ts ?? null,
      dropoff_completed_ts: dropoff?.activity_completed_ts ?? null,
    });
  }
  trips.sort((a, b) => (b.requested_ts ?? "").localeCompare(a.requested_ts ?? ""));
  return NextResponse.json({ trips });
}

// POST /api/ndtp — { dropoff_id, note? }. Creates an unassigned pickup job (the assign
// cycle places it by config, like any client pickup) and tells the admin group.
export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const body = await req.json().catch(() => ({}));
  const dropoff = NDTP_DROPOFFS.find((d) => d.customer_id === body?.dropoff_id);
  if (!dropoff) return NextResponse.json({ error: "Nơi giao không hợp lệ" }, { status: 400 });
  const note = String(body?.note ?? "").trim().slice(0, 500);

  // Double-tap guard only (120s); a second real request for the same site is allowed after.
  const lockKey = `ndtp:${dropoff.customer_id}-${vnDate()}`;
  if (!(await acquireCreateLock(lockKey))) {
    return NextResponse.json(
      { error: "Yêu cầu tới nơi này vừa được ghi nhận. Vui lòng đợi 2 phút trước khi gửi lại." },
      { status: 409 },
    );
  }

  const { hours, minutes } = vnHoursMinutes();
  const hhmm = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  const reference = `NDTP→${dropoff.name.split(" - ").pop()}_${hhmm}`;

  try {
    const res = await createJob(
      {
        job_type_id: 1,
        schedule_type_id: 1,
        reference_number: reference,
        // The requester's note rides on the item, NOT the stop: any stop note holds the
        // job out of auto-assign until a supervisor approves it.
        ...(note ? { items: [{ description: `📝 ${note}`, item_type_id: 1, quantity: 1, weight: 0, tracking_number: "" }] } : {}),
        stops: [
          {
            stop_type_id: 1,
            customer_id: NDTP_PICKUP.customer_id,
            duration: 5,
            todos: [
              { todo_type_id: 2, description: "📦 Chụp rõ số lượng và thông tin mẫu nhận" },
              { todo_type_id: 5, description: "Số lượng mẫu" },
            ],
          },
          {
            stop_type_id: 2,
            customer_id: dropoff.customer_id,
            duration: 5,
            todos: [{ todo_type_id: 2, description: "🤝 Chụp rõ mẫu tại khu vực bàn giao" }],
          },
        ],
      },
      env,
    );

    if (!res.ok) {
      // A 5xx may still have created the trip — keep the lock so a retap cannot make a twin.
      if (res.status < 500) void releaseCreateLock(lockKey);
      return NextResponse.json({ error: "Không tạo được yêu cầu. Vui lòng thử lại.", details: res.body }, { status: 502 });
    }

    const jobId = res.body?.data?.job_id ?? null;
    await notifyAdminGroup(
      `🧪 Yêu cầu lấy mẫu NĐTP (${hhmm})\n` +
        `Từ: ${NDTP_PICKUP.name}\n` +
        `Đến: ${dropoff.name}\n` +
        `Job #${jobId ?? "?"}` +
        (note ? `\nGhi chú: ${note}` : ""),
    );

    return NextResponse.json({ success: true, job_id: jobId, reference });
  } catch (e) {
    // Thrown after the create was sent: unknown whether it exists, so the lock stays.
    return NextResponse.json({ error: "Chưa xác nhận được yêu cầu. Vui lòng liên hệ điều phối trước khi gửi lại.", details: String(e) }, { status: 502 });
  }
}
