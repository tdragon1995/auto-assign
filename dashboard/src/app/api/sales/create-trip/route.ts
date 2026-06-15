import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, type Env } from "@/lib/cartrack";
import { loadPscRoutes } from "@/lib/psc-config";
import { haversineKm } from "@/lib/distance";
import { vnDate, vnHoursMinutes, vnTimestamp } from "@/lib/time";
import { pushRunLog } from "@/lib/smart-log-kv";

export const runtime = "edge";
export const preferredRegion = "sin1";

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const { customer_id, lat, lon, ma_kh, note } = await req.json() as {
      customer_id: string;
      lat: number;
      lon: number;
      ma_kh: string;
      note?: string | null;
    };

    if (!customer_id || lat == null || lon == null || !ma_kh) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Load PSC coords from sheet (cached via psc-config)
    const routes = await loadPscRoutes();
    const pscs = routes
      .filter((r) => r.pickup && r.lat != null && r.lon != null)
      .reduce<{ customer_id: string; customer_name: string; lat: number; lon: number }[]>((acc, r) => {
        if (!acc.find((p) => p.customer_id === r.pickup)) {
          acc.push({ customer_id: r.pickup, customer_name: r.psc_pickup, lat: r.lat!, lon: r.lon! });
        }
        return acc;
      }, []);

    if (pscs.length === 0) {
      return NextResponse.json({ error: "Không có PSC nào có toạ độ trong sheet" }, { status: 500 });
    }

    const closest = pscs.reduce((best, psc) => {
      const d = haversineKm(lat, lon, psc.lat, psc.lon);
      return d < best.dist ? { psc, dist: d } : best;
    }, { psc: pscs[0], dist: haversineKm(lat, lon, pscs[0].lat, pscs[0].lon) });

    // Reference: DDMMYYYY-hh:mm-{ma_kh}
    const [yyyy, mo, dd] = vnDate().split("-");
    const { hours, minutes } = vnHoursMinutes();
    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    const refNumber = `${dd}${mo}${yyyy}-${hh}:${mm}-${ma_kh}`;

    const jobPayload = {
      job_type_id: 1,
      schedule_type_id: 1,
      reference_number: refNumber,
      labels: ["🛵 Vận chuyển mẫu B2B"],
      stops: [
        {
          stop_type_id: 1,
          customer_id,
          duration: 5,
          note: note || null,
          todos: [
            { todo_type_id: 5, description: "Note @ pickup" },
            { todo_type_id: 2, description: "Take a photo @ pickup" },
            { todo_type_id: 1, description: "e-Sign @ pickup" },
          ],
        },
        {
          stop_type_id: 2,
          customer_id: closest.psc.customer_id,
          duration: 5,
          todos: [
            { todo_type_id: 5, description: "Note @ dropoff" },
            { todo_type_id: 2, description: "Take a photo @ dropoff" },
            { todo_type_id: 1, description: "e-Sign @ dropoff" },
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
      const err = await createRes.json().catch(() => ({}));
      return NextResponse.json({ error: "Tạo chuyến thất bại", details: err }, { status: createRes.status });
    }

    const created = await createRes.json();
    const jobId = created.data?.job_id;
    void pushRunLog([{
      ts: vnTimestamp(),
      level: "OK",
      msg: `[Sales] Tạo chuyến B2B: Job ${jobId}, Ref: ${refNumber} | ${closest.psc.customer_name}`,
    }]);
    return NextResponse.json({
      success: true,
      job_id: jobId,
      reference_number: refNumber,
      dropoff_psc: closest.psc.customer_name,
      distance_km: Math.round(closest.dist * 10) / 10,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
