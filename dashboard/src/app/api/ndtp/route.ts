import { NextRequest, NextResponse } from "next/server";
import { createJob, type Env } from "@/lib/cartrack";
import { addDays, vnDate, vnHoursMinutes, vnTimestamp } from "@/lib/time";
import { acquireCreateLock, pushRunLog, releaseCreateLock } from "@/lib/smart-log-kv";
import { parkScheduledJob } from "@/lib/scheduled-dispatch";
import { notifyAdminGroup } from "@/lib/zalo";
import { NDTP_DROPOFFS, NDTP_PICKUP } from "@/lib/ndtp";
import { locationJobs } from "@/lib/day-snapshot";
import { proxyKind } from "@/lib/proxy-drivers";
import { cancelOwnTrip } from "@/lib/pickup-trips";

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
  /** Booked from /ndtp — the only trips the page may cancel. */
  own: boolean;
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
      own: isNdtpBooking(j),
    });
  }
  trips.sort((a, b) => (b.requested_ts ?? "").localeCompare(a.requested_ts ?? ""));
  return NextResponse.json({ trips });
}

// A tomorrow request is a pickup at this time, booked the /psc-tinh way.
const TOMORROW_PICKUP = "08:00";

// POST /api/ndtp — { dropoff_id, day?: "today" | "tomorrow" }. Today: an unassigned pickup
// the assign cycle places by config, like any client pickup. Tomorrow: dated tomorrow with
// an 08:00 pickup window and parked on the queue proxy, which the engine releases an hour
// before. Either way the admin group is told.
export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const body = await req.json().catch(() => ({}));
  const dropoff = NDTP_DROPOFFS.find((d) => d.customer_id === body?.dropoff_id);
  if (!dropoff) return NextResponse.json({ error: "Nơi giao không hợp lệ" }, { status: 400 });
  const tomorrow = body?.day === "tomorrow" ? addDays(vnDate(), 1) : null;

  // Double-tap guard only (120s); a second real request for the same site is allowed after.
  const lockKey = `ndtp:${dropoff.customer_id}-${tomorrow ?? vnDate()}`;
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
        // Day-start makes tomorrow's job visible from midnight; the time lives in the window.
        ...(tomorrow
          ? { schedule_type_id: 2, scheduled_delivery_ts: `${tomorrow} 00:00:00` }
          : { schedule_type_id: 1 }),
        reference_number: reference,
        stops: [
          {
            stop_type_id: 1,
            customer_id: NDTP_PICKUP.customer_id,
            duration: 5,
            ...(tomorrow
              ? { delivery_windows: [{ time_from: `${TOMORROW_PICKUP}:00+07:00`, time_to: "08:30:00+07:00" }] }
              : {}),
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
    let warning: string | null = null;
    if (tomorrow && jobId) {
      try {
        await parkScheduledJob(jobId, `${tomorrow} ${TOMORROW_PICKUP}:00`, env);
      } catch (e) {
        // The trip exists. Never answer with an error that invites a second one.
        warning = `Đã tạo Job #${jobId}, nhưng chưa hoàn tất hẹn giờ. Vui lòng báo điều phối, không gửi lại yêu cầu.`;
        await pushRunLog([{ ts: vnTimestamp(), level: "ERROR", msg: `[NĐTP] Job ${jobId} - Hẹn giờ THẤT BẠI: ${e} | ${tomorrow} ${TOMORROW_PICKUP}` }]).catch(() => {});
      }
    }

    const when = tomorrow ? `ngày mai ${tomorrow.slice(8, 10)}/${tomorrow.slice(5, 7)} lúc ${TOMORROW_PICKUP}` : `gửi lúc ${hhmm}`;
    await notifyAdminGroup(
      `🧪 Yêu cầu lấy mẫu NĐTP (${when})\n` +
        `Từ: ${NDTP_PICKUP.name}\n` +
        `Đến: ${dropoff.name}\n` +
        `Job #${jobId ?? "?"}` +
        (warning ? "\n⚠️ Chưa hẹn giờ được — cần xử lý tay" : ""),
    );

    return NextResponse.json({ success: true, job_id: jobId, reference, delivery_date: tomorrow ?? vnDate(), warning });
  } catch (e) {
    // Thrown after the create was sent: unknown whether it exists, so the lock stays.
    return NextResponse.json({ error: "Chưa xác nhận được yêu cầu. Vui lòng liên hệ điều phối trước khi gửi lại.", details: String(e) }, { status: 502 });
  }
}

/** A trip this page booked — its reference is written by POST above. Anything else at
 *  the NĐTP pickup (Labcenter, dispatch, scheduled runs) is not the page's to cancel. */
const isNdtpBooking = (j: { reference_number?: string | null }) => (j.reference_number ?? "").startsWith("NDTP→");

// DELETE /api/ndtp?job_id=123 — cancel a trip booked from /ndtp while its pickup is untouched.
export async function DELETE(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const jobId = Number(req.nextUrl.searchParams.get("job_id"));
  if (!Number.isInteger(jobId) || jobId <= 0) return NextResponse.json({ error: "Job ID không hợp lệ" }, { status: 400 });
  try {
    const out = await cancelOwnTrip(jobId, env, isNdtpBooking);
    if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
    // Free the double-tap guard so a corrected request can go straight in.
    void releaseCreateLock(`ndtp:${out.dropoffId}-${vnDate()}`);
    return NextResponse.json({ success: true, job_id: jobId });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
