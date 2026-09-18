import { NextRequest, NextResponse } from "next/server";
import { createJob, type Env } from "@/lib/cartrack";
import { vnDate, vnHoursMinutes } from "@/lib/time";
import { acquireCreateLock, releaseCreateLock } from "@/lib/smart-log-kv";
import { CORP_CLINICS, CORP_DROPOFF_ID, CORP_LABEL, normalizeVnPhone } from "@/lib/corp";
import { pickupTripsToday } from "@/lib/pickup-trips";

export const runtime = "nodejs";
export const preferredRegion = "sin1";
// The pickup phone (and the new label, which has no RPC id) keep this off the fast RPC
// create, so it takes the REST path, which has been measured at ~11s.
export const maxDuration = 60;

// GET /api/corp — today's trips booked from /corp (label "Mẫu Corp").
export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const trips = await pickupTripsToday(env, CORP_CLINICS.map((c) => c.customer_id), CORP_LABEL);
  if (!trips) return NextResponse.json({ error: "Chưa tải được danh sách chuyến" }, { status: 503 });
  return NextResponse.json({ trips });
}

// POST /api/corp — { clinic_id, phone }. Creates an unassigned clinic → D001 pickup the
// assign cycle places by config. `phone` is set on THIS trip's pickup stop only; the
// clinic's saved Cartrack number is untouched (verified 2026-09-18).
export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const body = await req.json().catch(() => ({}));
  const clinic = CORP_CLINICS.find((c) => c.customer_id === body?.clinic_id);
  if (!clinic) return NextResponse.json({ error: "Phòng khám không hợp lệ" }, { status: 400 });
  const phone = normalizeVnPhone(String(body?.phone ?? ""));
  if (!phone) return NextResponse.json({ error: "Số điện thoại không hợp lệ" }, { status: 400 });

  // Double-tap guard only (120s); a second real request is allowed after.
  const lockKey = `corp:${clinic.customer_id}-${vnDate()}`;
  if (!(await acquireCreateLock(lockKey))) {
    return NextResponse.json(
      { error: "Yêu cầu vừa được ghi nhận. Vui lòng đợi 2 phút trước khi gửi lại." },
      { status: 409 },
    );
  }

  const { hours, minutes } = vnHoursMinutes();
  const hhmm = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  const reference = `${clinic.short}→D001_${hhmm}`;

  try {
    const res = await createJob(
      {
        job_type_id: 1,
        schedule_type_id: 1,
        reference_number: reference,
        labels: [CORP_LABEL],
        stops: [
          {
            stop_type_id: 1,
            customer_id: clinic.customer_id,
            duration: 5,
            contact_code: "84",
            contact_number: phone,
            todos: [
              { todo_type_id: 2, description: "📦 Chụp rõ số lượng và thông tin mẫu nhận" },
              { todo_type_id: 5, description: "Ghi chú" },
            ],
          },
          {
            stop_type_id: 2,
            customer_id: CORP_DROPOFF_ID,
            duration: 5,
            todos: [
              { todo_type_id: 2, description: "🤝 Chụp rõ mẫu tại khu vực bàn giao" },
              { todo_type_id: 5, description: "Ghi chú" },
            ],
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
    return NextResponse.json({ success: true, job_id: res.body?.data?.job_id ?? null, reference });
  } catch (e) {
    // Thrown after the create was sent: unknown whether it exists, so the lock stays.
    return NextResponse.json({ error: "Chưa xác nhận được yêu cầu. Vui lòng liên hệ điều phối trước khi gửi lại.", details: String(e) }, { status: 502 });
  }
}
