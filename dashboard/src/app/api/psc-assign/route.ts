import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { type Env } from "@/lib/cartrack";

export const runtime = "edge";
export const preferredRegion = "sin1";

const BASE_URL = "https://fleetapi-vn.cartrack.com/rest/delivery";

function getHeaders(env: Env = "prod"): Record<string, string> {
  const suffix = env === "uat" ? "_UAT" : "";
  const auth = process.env[`CARTRACK_AUTH${suffix}`] ?? "";
  const cookie = process.env[`CARTRACK_COOKIE${suffix}`] ?? "";
  if (!auth) throw new Error(`CARTRACK_AUTH${suffix} not set`);

  const headers: Record<string, string> = {
    Authorization: auth,
    "Content-Type": "application/json",
  };
  if (cookie) headers["Cookie"] = cookie;
  return headers;
}

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const body = await req.json();
    const {
      psc_pickup,
      dropoff_location,
      pickup,
      dropoff,
      ref_number,
    } = body;

    if (!pickup || !dropoff || !psc_pickup) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const refLabel = ref_number || `${psc_pickup}▶️${dropoff_location}`;

    const jobPayload = {
      job_type_id: 1,
      schedule_type_id: 1,
      reference_number: refLabel,
      labels: ["🛵 Vận chuyển mẫu PSC"],
      stops: [
        {
          stop_type_id: 1,
          customer_id: pickup,
          customer_name: psc_pickup,
          duration: 5,
          todos: [
            { todo_type_id: 2, description: "📦 Chụp thấy rõ mẫu đã đóng gói trong hộp" },
            { todo_type_id: 2, description: "✍️ Chụp batchsheet đã ký" },
          ],
        },
        {
          stop_type_id: 2,
          customer_id: dropoff,
          customer_name: dropoff_location,
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

    // Fire the Cartrack API call in the background — don't block the response
    waitUntil(
      fetch(`${BASE_URL}/jobs`, {
        method: "POST",
        headers: getHeaders(env),
        body: JSON.stringify(jobPayload),
      }).catch((e) => console.error("Cartrack job creation failed:", e))
    );

    // Return instantly
    return NextResponse.json({
      success: true,
      reference: refLabel,
    });
  } catch (e) {
    return NextResponse.json(
      { error: String(e) },
      { status: 500 }
    );
  }
}
