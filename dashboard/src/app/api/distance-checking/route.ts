import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";
export const preferredRegion = "sin1";

const GOONG_API = "https://rsapi.goong.io/v2/distancematrix";

export interface DistanceRow {
  route: string;
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

async function queryGoong(row: DistanceRow, apiKey: string): Promise<DistanceResult> {
  try {
    const url = `${GOONG_API}?origins=${row.lat1},${row.lon1}&destinations=${row.lat2},${row.lon2}&vehicle=bike&api_key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return { ...row, distance_km: null, duration_mins: null, error: `HTTP ${res.status}` };
    const data = await res.json();
    const el = data.rows?.[0]?.elements?.[0];
    if (!el || el.status !== "OK") {
      return { ...row, distance_km: null, duration_mins: null, error: el?.status ?? "No result" };
    }
    return {
      ...row,
      distance_km: Math.round(el.distance.value / 100) / 10,
      duration_mins: Math.round(el.duration.value / 60),
    };
  } catch (e) {
    return { ...row, distance_km: null, duration_mins: null, error: String(e) };
  }
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.GOONG_API_KEY ?? "";
  if (!apiKey) return NextResponse.json({ error: "GOONG_API_KEY not set" }, { status: 500 });

  try {
    const { rows } = await req.json() as { rows: DistanceRow[] };
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: "No rows provided" }, { status: 400 });
    }
    if (rows.length > 1000) {
      return NextResponse.json({ error: "Max 1000 rows per request" }, { status: 400 });
    }

    // Process in batches of 5 — client sends chunks of 100, so this stays well under rate limits
    const BATCH = 5;
    const results: DistanceResult[] = [];
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map((row) => queryGoong(row, apiKey)));
      results.push(...batchResults);
    }

    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
