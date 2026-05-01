import { NextRequest, NextResponse } from "next/server";
import { goongMatrix } from "@/lib/distance";

export const runtime = "edge";
export const preferredRegion = "sin1";

export interface DistanceRow {
  pickup: string;
  dropoff: string;
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
}

export interface DistanceResult extends DistanceRow {
  distance_km: number | null;
  duration_mins: number | null;
  error?: string;
}

export async function POST(req: NextRequest) {
  if (!process.env.GOONG_API_KEY) {
    return NextResponse.json({ error: "GOONG_API_KEY not set" }, { status: 500 });
  }

  try {
    const { rows } = await req.json() as { rows: DistanceRow[] };
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: "No rows provided" }, { status: 400 });
    }
    if (rows.length > 1000) {
      return NextResponse.json({ error: "Max 1000 rows per request" }, { status: 400 });
    }

    // Sequential with 1s gap — caps at ~1 RPS to stay under Goong rate limit
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const results: DistanceResult[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const [r] = await goongMatrix(row.lat1, row.lon1, [{ lat: row.lat2, lon: row.lon2 }]);
      results.push({
        ...row,
        distance_km: r?.distance_km ?? null,
        duration_mins: r?.eta_mins ?? null,
      });
      if (i < rows.length - 1) await sleep(1000);
    }

    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
