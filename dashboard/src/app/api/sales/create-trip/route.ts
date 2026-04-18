import { NextRequest, NextResponse } from "next/server";
import { type Env } from "@/lib/cartrack";
import { loadPscRoutes } from "@/lib/psc-config";

export const runtime = "edge";
export const preferredRegion = "sin1";

const BASE_URL = "https://fleetapi-vn.cartrack.com/rest/delivery";

function getHeaders(env: Env = "prod"): Record<string, string> {
  const suffix = env === "uat" ? "_UAT" : "";
  const auth = process.env[`CARTRACK_AUTH${suffix}`] ?? "";
  if (!auth) throw new Error(`CARTRACK_AUTH${suffix} not set`);
  return { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" };
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const { customer_id, customer_name, lat, lon, ma_kh } = await req.json() as {
      customer_id: string;
      customer_name: string;
      lat: number;
      lon: number;
      ma_kh: string;
    };

    if (!customer_id || !customer_name || lat == null || lon == null || !ma_kh) {
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
    const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const dd   = String(vnNow.getUTCDate()).padStart(2, "0");
    const mo   = String(vnNow.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = vnNow.getUTCFullYear();
    const hh   = String(vnNow.getUTCHours()).padStart(2, "0");
    const mm   = String(vnNow.getUTCMinutes()).padStart(2, "0");
    const refNumber = `${dd}${mo}${yyyy}-${hh}:${mm}-${ma_kh}`;

    const jobPayload = {
      job_type_id: 1,
      schedule_type_id: 1,
      reference_number: refNumber,
      labels: ["🏠 Sales"],
      stops: [
        {
          stop_type_id: 1,
          customer_id,
          customer_name,
          duration: 5,
          todos: [
            { todo_type_id: 5, description: "Note @ pickup" },
            { todo_type_id: 2, description: "Take a photo @ pickup" },
            { todo_type_id: 1, description: "e-Sign @ pickup" },
          ],
        },
        {
          stop_type_id: 2,
          customer_id: closest.psc.customer_id,
          customer_name: closest.psc.customer_name,
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
    return NextResponse.json({
      success: true,
      job_id: created.data?.job_id,
      reference_number: refNumber,
      dropoff_psc: closest.psc.customer_name,
      distance_km: Math.round(closest.dist * 10) / 10,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
