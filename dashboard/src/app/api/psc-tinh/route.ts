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

// ── GET /api/psc-tinh?psc=D021 ───────────────────────────────────────────────
// Returns 3PL options from sheet (address already in sheet — no Cartrack fetch needed)

export async function GET(req: NextRequest) {
  const psc = req.nextUrl.searchParams.get("psc")?.trim().toUpperCase();
  if (!psc) return NextResponse.json({ error: "Missing psc param" }, { status: 400 });

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
    const { psc_code, tpl_uuid, tpl_name, eta } = await req.json();

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

    // Build ETA window: time_from = eta, time_to = eta + 5 min (Cartrack requires from < to)
    const [etaH, etaM] = eta.split(":").map(Number);
    const toMins = etaH * 60 + etaM + 5;
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
          delivery_windows: [{ time_from: etaFrom, time_to: etaTo }],
          todos: [
            { todo_type_id: 2, description: "📦 Chụp thấy rõ mẫu đã đóng gói trong hộp" },
            { todo_type_id: 2, description: "✍️ Chụp batchsheet đã ký" },
          ],
        },
        {
          stop_type_id: 2,
          customer_id: D001_UUID,
          customer_name: "D001 - Cao Thắng",
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
