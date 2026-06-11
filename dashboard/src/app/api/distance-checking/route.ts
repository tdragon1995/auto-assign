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

// Dedicated Goong key for this module so bulk checking can't drain the
// auto-assign/smart-rank quota. Falls back to the shared key if unset.
const DISTANCE_API_KEY = process.env.GOONG_API_KEY_DISTANCE || process.env.GOONG_API_KEY || "";

// Max destinations per Goong matrix call (Goong documents no hard cap; keep
// URLs/payloads sane).
const MAX_DEST_PER_CALL = 10;

// Group rows that share a pickup so each distinct pickup costs one matrix call
// (1 origin → N destinations) instead of one call per row.
function pickupKey(lat: number, lon: number): string {
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

export async function POST(req: NextRequest) {
  if (!DISTANCE_API_KEY) {
    return NextResponse.json({ error: "GOONG_API_KEY_DISTANCE / GOONG_API_KEY not set" }, { status: 500 });
  }

  try {
    const { rows } = await req.json() as { rows: DistanceRow[] };
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: "No rows provided" }, { status: 400 });
    }
    if (rows.length > 1000) {
      return NextResponse.json({ error: "Max 1000 rows per request" }, { status: 400 });
    }

    // Group row indices by pickup coordinate.
    const groups = new Map<string, { lat1: number; lon1: number; indices: number[] }>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const key = pickupKey(row.lat1, row.lon1);
      const g = groups.get(key);
      if (g) g.indices.push(i);
      else groups.set(key, { lat1: row.lat1, lon1: row.lon1, indices: [i] });
    }

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const results: DistanceResult[] = new Array(rows.length);

    // One matrix call per pickup (chunked if it has many dropoffs). 1s gap
    // between calls caps at ~1 RPS to stay under Goong's rate limit.
    let firstCall = true;
    for (const { lat1, lon1, indices } of groups.values()) {
      for (let off = 0; off < indices.length; off += MAX_DEST_PER_CALL) {
        const slice = indices.slice(off, off + MAX_DEST_PER_CALL);
        const dests = slice.map((idx) => ({ lat: rows[idx].lat2, lon: rows[idx].lon2 }));

        if (!firstCall) await sleep(1000);
        firstCall = false;

        const matrix = await goongMatrix(lat1, lon1, dests, DISTANCE_API_KEY);
        slice.forEach((idx, j) => {
          const r = matrix[j];
          results[idx] = {
            ...rows[idx],
            distance_km: r?.distance_km ?? null,
            duration_mins: r?.eta_mins ?? null,
          };
        });
      }
    }

    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
