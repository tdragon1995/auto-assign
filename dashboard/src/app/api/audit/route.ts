import { NextRequest, NextResponse } from "next/server";
import { assignJob, BASE_URL, getHeaders, type Env } from "@/lib/cartrack";
import { loadPscRoutes } from "@/lib/psc-config";
import { vnDate, vnHoursMinutes } from "@/lib/time";

const CACHE_TTL_MS = 5 * 60 * 1000;

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

// ── Location cache ─────────────────────────────────────────────────────────

interface LocationEntry {
  customer_id: string;
  name: string;
  address: string;
}

let locationsCache: { data: LocationEntry[]; ts: number } | null = null;

async function fetchLocations(env: Env): Promise<LocationEntry[]> {
  if (locationsCache && Date.now() - locationsCache.ts < CACHE_TTL_MS) {
    return locationsCache.data;
  }

  const routes = await loadPscRoutes();
  const seen = new Set<string>();
  const pickups: { customer_id: string; name: string }[] = [];
  for (const r of routes) {
    if (r.pickup && r.psc_pickup && !seen.has(r.pickup)) {
      seen.add(r.pickup);
      pickups.push({ customer_id: r.pickup, name: r.psc_pickup });
    }
  }

  const headers = getHeaders(env);
  const enriched = await Promise.all(
    pickups.map(async (p) => {
      try {
        const res = await fetch(`${BASE_URL}/customers/${p.customer_id}`, { headers });
        if (!res.ok) return { ...p, address: "" };
        const data = await res.json();
        const c = data.data ?? data;
        const address = [c.address_line_1, c.address_line_2].filter(Boolean).join(", ");
        return { customer_id: p.customer_id, name: p.name, address };
      } catch {
        return { ...p, address: "" };
      }
    })
  );

  enriched.sort((a, b) => a.name.localeCompare(b.name, "vi"));
  locationsCache = { data: enriched, ts: Date.now() };
  return enriched;
}

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

  try {
    const pscs = await fetchLocations(env);
    return NextResponse.json({ pscs });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── POST /api/audit — create audit job + auto-assign to driver ────────────

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const { driver_id, driver_first_name, driver_last_name, driver_full_name, location_customer_id, location_name } =
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
      items: AUDIT_ITEMS,
      stops: [
        {
          stop_type_id: 3,
          customer_id: location_customer_id,
          customer_name: location_name,
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

    const assignResult = await assignJob(driver_id, jobId, env);
    if (assignResult.status !== 200) {
      return NextResponse.json(
        {
          warning: "Job đã tạo nhưng không thể gán tài xế",
          job_id: jobId,
          reference_number: refNumber,
          assign_status: assignResult.status,
        },
        { status: 207 }
      );
    }

    return NextResponse.json({ success: true, job_id: jobId, reference_number: refNumber });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
