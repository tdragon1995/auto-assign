import { NextRequest, NextResponse } from "next/server";
import { loadTplEntries } from "@/lib/psc-config";
import { type Env } from "@/lib/cartrack";

export const runtime = "edge";
export const preferredRegion = "sin1";

const BASE_URL = "https://fleetapi-vn.cartrack.com/rest/delivery";
const D001_UUID = "3927b076-3af9-11ed-b939-506b8dbc8dfb";

function getHeaders(env: Env = "prod"): Record<string, string> {
  const suffix = env === "uat" ? "_UAT" : "";
  const auth = process.env[`CARTRACK_AUTH${suffix}`] ?? "";
  const cookie = process.env[`CARTRACK_COOKIE${suffix}`] ?? "";
  if (!auth) throw new Error(`CARTRACK_AUTH${suffix} not set`);
  const headers: Record<string, string> = { Authorization: auth, "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = cookie;
  return headers;
}

// Stop/job status labels in Vietnamese
const STOP_STATUS: Record<number, { label: string; color: string }> = {
  1: { label: "Chờ lấy",    color: "slate"  },
  2: { label: "Đang đến",   color: "blue"   },
  3: { label: "Đã đến",     color: "indigo" },
  4: { label: "Hoàn thành", color: "green"  },
  5: { label: "Từ chối",    color: "red"    },
};

const JOB_STATUS: Record<number, string> = {
  2: "Chờ phân công",
  3: "Thất bại",
  4: "Đã phân công",
  5: "Hoàn thành",
  7: "Đã huỷ",
};

// ── GET /api/psc-tinh?psc=D021 — 3PL options ─────────────────────────────────
// GET /api/psc-tinh?psc=D021&mode=orders — today's orders for this PSC

export async function GET(req: NextRequest) {
  const psc  = req.nextUrl.searchParams.get("psc")?.trim().toUpperCase();
  const mode = req.nextUrl.searchParams.get("mode");
  const env  = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  if (!psc) return NextResponse.json({ error: "Missing psc param" }, { status: 400 });

  // ── mode=orders: fetch today's jobs for this PSC ──────────────────────────
  if (mode === "orders") {
    try {
      const headers = getHeaders(env);
      const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
      const today = vnNow.toISOString().split("T")[0];
      const prefix = `BRA - ${psc} - Mẫu`;

      const [jobsRes, tplEntries] = await Promise.all([
        fetch(
          `${BASE_URL}/jobs?filter[scheduled_delivery_ts_from]=${today} 00:00:00&filter[scheduled_delivery_ts_to]=${today} 23:59:59&limit=1000`,
          { headers, cache: "no-store" }
        ),
        loadTplEntries(),
      ]);
      if (!jobsRes.ok) return NextResponse.json({ orders: [] });

      const tplByUuid = new Map(tplEntries.map((e) => [e.tpl_uuid, e.address]));
      const data = await jobsRes.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jobs: any[] = data.data ?? [];

      const orders = jobs
        .filter((j) => (j.reference_number ?? "").startsWith(prefix) && j.job_status_id !== 3 && j.job_status_id !== 7)
        .sort((a, b) => (a.reference_number ?? "").localeCompare(b.reference_number ?? ""))
        .map((j) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const stops: any[] = j.stops ?? [];
          const pickup  = stops.find((s: any) => s.stop_type_id === 1);
          const dropoff = stops.find((s: any) => s.stop_type_id === 2);
          return {
            job_id:    j.job_id,
            reference: j.reference_number,
            job_status: JOB_STATUS[j.job_status_id] ?? "Không rõ",
            pickup_name:      pickup?.customer_name ?? null,
            pickup_address:   tplByUuid.get(pickup?.customer_id) ?? null,
            pickup_stop_id:   (pickup?.stop_id ?? null) as number | null,
            pickup_status_id: (pickup?.stop_status_id ?? null) as number | null,
            dropoff_status_id: dropoff?.stop_status_id ?? null,
            dropoff_status:    STOP_STATUS[dropoff?.stop_status_id]?.label ?? "—",
            dropoff_color:     STOP_STATUS[dropoff?.stop_status_id]?.color ?? "slate",
            dropoff_update_ts: (
              dropoff?.activity_completed_ts ??
              dropoff?.activity_arrived_ts ??
              dropoff?.activity_started_ts ??
              null
            ),
            eta: pickup?.delivery_windows?.[0]?.time_from?.slice(0, 5) ?? null,
          };
        });

      return NextResponse.json({ orders });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 });
    }
  }

  // ── default: 3PL options ──────────────────────────────────────────────────
  try {
    const entries = await loadTplEntries();
    const options = entries
      .filter((e) => e.psc_tinh.toUpperCase().includes(psc))
      .map((e) => ({
        tpl_uuid: e.tpl_uuid,
        tpl_name: e.tpl_name,
        address: e.address,
      }));

    return NextResponse.json({ options });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── POST /api/psc-tinh ───────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const { psc_code, tpl_uuid, tpl_name, eta, note } = await req.json();

    if (!psc_code || !tpl_uuid || !eta) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const headers = getHeaders(env);

    // Count today's non-cancelled jobs from this PSC for reference_number
    const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const today = vnNow.toISOString().split("T")[0];
    const prefix = `BRA - ${psc_code} - Mẫu`;

    const countRes = await fetch(
      `${BASE_URL}/jobs?filter[scheduled_delivery_ts_from]=${today} 00:00:00&filter[scheduled_delivery_ts_to]=${today} 23:59:59&limit=1000`,
      { headers, cache: "no-store" }
    );

    let count = 0;
    if (countRes.ok) {
      const countData = await countRes.json();
      const jobs: { reference_number?: string; job_status_id?: number }[] = countData.data ?? [];
      count = jobs.filter(
        (j) => j.job_status_id !== 7 && j.job_status_id !== 3 && (j.reference_number ?? "").startsWith(prefix)
      ).length;
    }

    const refNumber = `${prefix} ${count + 1}`;

    // Build ETA window: time_from = eta, time_to = eta + 30 min
    const [etaH, etaM] = eta.split(":").map(Number);
    const toMins = etaH * 60 + etaM + 30;
    const toH = String(Math.floor(toMins / 60) % 24).padStart(2, "0");
    const toMin = String(toMins % 60).padStart(2, "0");
    const etaFrom = `${eta}:00+07:00`;
    const etaTo = `${toH}:${toMin}:00+07:00`;

    const jobPayload = {
      job_type_id: 1,
      schedule_type_id: 1,
      reference_number: refNumber,
      labels: ["🛵 Vận chuyển mẫu tỉnh"],
      stops: [
        {
          stop_type_id: 1,
          customer_id: tpl_uuid,
          customer_name: tpl_name,
          duration: 5,
          note: note || null,
          delivery_windows: [{ time_from: etaFrom, time_to: etaTo }],
          todos: [
            { todo_type_id: 2, description: "" },
            { todo_type_id: 5, description: "" },
          ],
        },
        {
          stop_type_id: 2,
          customer_id: D001_UUID,
          customer_name: "D001 - Cao Thắng",
          duration: 10,
          todos: [
            { todo_type_id: 2, description: "" },
            { todo_type_id: 5, description: "" },
          ],
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
      return NextResponse.json({ error: "Failed to create job", details: errBody }, { status: createRes.status });
    }

    const created = await createRes.json();
    return NextResponse.json({
      success: true,
      reference: refNumber,
      job_id: created.data?.job_id,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── DELETE /api/psc-tinh?job_id=123 — cancel job (only if not started) ───────

export async function DELETE(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const jobId = req.nextUrl.searchParams.get("job_id");

  if (!jobId) return NextResponse.json({ error: "Missing job_id" }, { status: 400 });

  try {
    const headers = getHeaders(env);

    const jobRes = await fetch(`${BASE_URL}/jobs/${jobId}`, { headers, cache: "no-store" });
    if (!jobRes.ok) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    const jobData = await jobRes.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stops: any[] = jobData.data?.stops ?? [];
    const pickup = stops.find((s) => s.stop_type_id === 1);
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

// ── PATCH /api/psc-tinh — update pickup ETA ──────────────────────────────────

export async function PATCH(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const { job_id, stop_id, eta } = await req.json();
    if (!job_id || !stop_id || !eta) {
      return NextResponse.json({ error: "Missing job_id, stop_id or eta" }, { status: 400 });
    }

    const [etaH, etaM] = (eta as string).split(":").map(Number);
    const toMins = etaH * 60 + etaM + 30;
    const toH = String(Math.floor(toMins / 60) % 24).padStart(2, "0");
    const toMin = String(toMins % 60).padStart(2, "0");
    const etaFrom = `${eta}:00+07:00`;
    const etaTo   = `${toH}:${toMin}:00+07:00`;

    const headers = getHeaders(env);

    // Fetch full job to get all stop fields required by Cartrack PUT
    const jobRes = await fetch(`${BASE_URL}/jobs/${job_id}`, { headers, cache: "no-store" });
    if (!jobRes.ok) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    const jobData = await jobRes.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentStops: any[] = jobData.data?.stops ?? [];

    const updatedStops = currentStops.map((s: any) => ({
      stop_id:       s.stop_id,
      stop_type_id:  s.stop_type_id,
      customer_id:   s.customer_id,
      customer_name: s.customer_name,
      country_id:    s.country_id,
      delivery_windows: s.stop_id === stop_id
        ? [{ time_from: etaFrom, time_to: etaTo }]
        : (s.delivery_windows ?? []),
    }));

    const res = await fetch(`${BASE_URL}/jobs/${job_id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ stops: updatedStops }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json({ error: "Failed to update ETA", details: err }, { status: res.status });
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
