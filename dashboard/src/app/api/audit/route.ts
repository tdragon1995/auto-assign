import { NextRequest, NextResponse } from "next/server";
import { deleteJob, BASE_URL, getHeaders, isDriverUnavailableError, type Env } from "@/lib/cartrack";
import { vnDate } from "@/lib/time";
import { DIAG_LOCATIONS } from "@/lib/diag-locations";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// 8 fixed audit items (from job #34252277)
const AUDIT_ITEMS = [
  {
    item_type_id: 2,
    description: "1. Ảnh toàn thân mặt trước, thấy rõ đầu tóc và giày: KHÔNG khẩu trang, nón bảo hiểm, áo khoác, túi giao nhận",
    quantity: 1,
    todos: [{ todo_type_id: 2, is_required: true, stop_type_id: 3 }],
  },
  {
    item_type_id: 2,
    description: "2. Ảnh toàn thân mặt sau, thấy rõ đầu tóc và giày: KHÔNG khẩu trang, nón bảo hiểm, áo khoác, túi giao nhận",
    quantity: 1,
    todos: [{ todo_type_id: 2, is_required: true, stop_type_id: 3 }],
  },
  {
    item_type_id: 2,
    description: "3. Ảnh toàn thân mặt trước, thấy rõ giày: CÓ đủ nón bảo hiểm, áo khoác và túi giao nhận",
    quantity: 1,
    todos: [{ todo_type_id: 2, is_required: true, stop_type_id: 3 }],
  },
  {
    item_type_id: 2,
    description: "4. Ảnh toàn thân mặt sau, thấy rõ giày: CÓ đủ nón bảo hiểm, áo khoác và túi giao nhận",
    quantity: 1,
    todos: [{ todo_type_id: 2, is_required: true, stop_type_id: 3 }],
  },
  {
    item_type_id: 2,
    description: "5. Ảnh túi giao nhận mặt chính diện",
    quantity: 1,
    todos: [{ todo_type_id: 2, is_required: true, stop_type_id: 3 }],
  },
  {
    item_type_id: 2,
    description: "6. Ảnh túi giao nhận mặt trong túi (thấy rõ các vật dụng bên trong)",
    quantity: 1,
    todos: [{ todo_type_id: 2, is_required: true, stop_type_id: 3 }],
  },
  {
    item_type_id: 2,
    description: "7.Ảnh đậu xe: Thấy rõ mặt tiền PSC, vị trí đậu xe và biển số xe của Nhân viên giao nhận",
    quantity: 1,
    todos: [{ todo_type_id: 2, is_required: true, stop_type_id: 3 }],
  },
  {
    item_type_id: 2,
    description: "8. Ảnh 02-04 hộp mẫu khác nhau đã được vệ sinh sạch sẽ, chụp trong 01 hình",
    quantity: 1,
    todos: [{ todo_type_id: 2, is_required: true, stop_type_id: 3 }],
  },
];

// ── Reference number builder ───────────────────────────────────────────────
// Format: audit_{YY}_{mon}_{dd}_{driver_code}_{last_name_no_spaces}
// driver_code = last segment after " - " in first_name (e.g. "F - C - DC100842" → "DC100842")
// last_name_no_spaces = last_name with spaces removed (Vietnamese chars preserved)

function buildReferenceNumber(dateVn: string, firstName: string, lastName: string): string {
  const [yyyy, mo, dd] = dateVn.split("-");
  const yy = yyyy.slice(-2);
  const mon = MONTHS[parseInt(mo) - 1];
  const parts = firstName.split(" - ");
  const driverCode = parts[parts.length - 1].trim();
  const lastNameNoSpaces = lastName.replace(/\s+/g, "");
  return `audit_${yy}_${mon}_${dd}_${driverCode}_${lastNameNoSpaces}`;
}

// ── GET /api/audit — location list OR duplicate check ─────────────────────

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const driverId = req.nextUrl.searchParams.get("driver_id");

  if (driverId) {
    try {
      const headers = getHeaders(env);
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

      const hasAuditToday = todayJobs.some(
        (j) =>
          (j.labels ?? []).includes("audit_weekly") &&
          j.job_status_id !== 7 &&
          j.job_status_id !== 3
      );

      return NextResponse.json({ hasAuditToday });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }
  }

  return NextResponse.json({ pscs: DIAG_LOCATIONS });
}

// ── POST /api/audit — create audit job + auto-assign to driver ────────────

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const { driver_id, driver_first_name, driver_last_name, driver_full_name, location_customer_id } =
      await req.json();

    if (!driver_id || !location_customer_id) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const headers = getHeaders(env);
    const today = vnDate();

    // Duplicate check: block if driver already has an audit job today
    const checkRes = await fetch(
      `${BASE_URL}/jobs?filter[driver_id]=${driver_id}&filter[create_ts_from]=${today} 00:00:00&filter[create_ts_to]=${today} 23:59:59&limit=100`,
      { headers, cache: "no-store" }
    );
    if (checkRes.ok) {
      const checkData = await checkRes.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const todayJobs: any[] = checkData.data ?? [];
      const hasAuditToday = todayJobs.some(
        (j) =>
          (j.labels ?? []).includes("audit_weekly") &&
          j.job_status_id !== 7 &&
          j.job_status_id !== 3
      );
      if (hasAuditToday) {
        return NextResponse.json(
          { error: "Tài xế đã tạo audit hôm nay rồi. Mỗi ngày chỉ được tạo 1 lần." },
          { status: 409 }
        );
      }
    }

    const refNumber = buildReferenceNumber(today, driver_first_name ?? "", driver_last_name ?? "");

    const jobPayload = {
      job_type_id: 3,
      schedule_type_id: 1,
      reference_number: refNumber,
      labels: ["audit_weekly"],
      delivery_driver_id: driver_id, // assign at creation — single call (Cartrack returns job_status_id 4)
      items: AUDIT_ITEMS,
      stops: [
        {
          stop_type_id: 3,
          customer_id: location_customer_id,
          duration: 5,
          note: "Công việc kiểm tra tác phong Nhân viên giao nhận",
        },
      ],
    };

    const createRes = await fetch(`${BASE_URL}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify(jobPayload),
    });

    if (!createRes.ok) {
      const errBody = await createRes.json().catch(() => ({}));
      if (isDriverUnavailableError(errBody)) {
        return NextResponse.json(
          { error: 'Nhân viên đang ở trạng thái "Nghỉ ngơi": Cần cập nhật trạng thái và thử lại!' },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: "Không thể tạo job. Vui lòng thử lại.", details: errBody },
        { status: createRes.status }
      );
    }

    const created = await createRes.json();
    const jobId: number | undefined = created.data?.job_id;
    if (!jobId) {
      return NextResponse.json({ error: "Cartrack không trả về job_id" }, { status: 500 });
    }

    // Defensive: a 200 can still come back unassigned (status 4 ≠ driver set). Verify, else roll back.
    if (created.data?.delivery_driver_id !== driver_id) {
      await deleteJob(jobId, env);
      return NextResponse.json(
        { error: "Tạo audit chưa thành công, vui lòng thử lại. Liên hệ điều phối nếu vẫn gặp lỗi!" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, job_id: jobId, reference_number: refNumber });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
