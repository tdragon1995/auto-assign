import { NextRequest, NextResponse } from "next/server";
import { roadDistancesFromPoint, exportCachedDistances, type DistanceSource } from "@/lib/distance-cache";

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
  // How the distance was obtained: "self"/"cache" = no Goong call, "api" = billed.
  source: DistanceSource | null;
  error?: string;
}

// Dedicated Goong key for this module so bulk checking can't drain the
// auto-assign/smart-rank quota. Falls back to the shared key if unset.
const DISTANCE_API_KEY = process.env.GOONG_API_KEY_DISTANCE || process.env.GOONG_API_KEY || "";

// Max destinations per Goong matrix call (Goong documents no hard cap; keep
// URLs/payloads sane).
const MAX_DEST_PER_CALL = 10;

// Parallel matrix calls per wave. A 10-simultaneous burst against this key
// returned all 200s (live test 2026-06-12), so 5 concurrent with a short gap
// stays well inside that headroom — vs the old 1 call/second pacing that made
// a 100-call sheet take 2+ minutes of mostly sleeping.
const CONCURRENCY = 5;
const WAVE_GAP_MS = 250;

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

    // Flatten groups into chunks: one matrix call per pickup, split if it has
    // more than MAX_DEST_PER_CALL dropoffs.
    interface Chunk { lat1: number; lon1: number; indices: number[] }
    const chunks: Chunk[] = [];
    for (const { lat1, lon1, indices } of groups.values()) {
      for (let off = 0; off < indices.length; off += MAX_DEST_PER_CALL) {
        chunks.push({ lat1, lon1, indices: indices.slice(off, off + MAX_DEST_PER_CALL) });
      }
    }

    // Returns true if at least one element came back — an all-null chunk almost
    // always means the call itself failed (timeout/429), not N unroutable pairs.
    // roadDistancesFromPoint serves self-pairs and cached pairs without calling
    // Goong at all, so re-checking a sheet costs almost nothing.
    const runChunk = async (chunk: Chunk): Promise<boolean> => {
      const dests = chunk.indices.map((idx) => ({ lat: rows[idx].lat2, lon: rows[idx].lon2 }));
      const matrix = await roadDistancesFromPoint(
        { lat: chunk.lat1, lon: chunk.lon1 }, dests, DISTANCE_API_KEY
      );
      chunk.indices.forEach((idx, j) => {
        const r = matrix[j];
        results[idx] = {
          ...rows[idx],
          distance_km: r?.distance_km ?? null,
          duration_mins: r?.eta_mins ?? null,
          source: r?.source ?? null,
        };
      });
      return matrix.some((r) => r !== null);
    };

    const failedChunks: Chunk[] = [];
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      if (i > 0) await sleep(WAVE_GAP_MS);
      const wave = chunks.slice(i, i + CONCURRENCY);
      const ok = await Promise.all(wave.map(runChunk));
      wave.forEach((c, j) => { if (!ok[j]) failedChunks.push(c); });
    }

    // Retry failed chunks once, gently paced, in case the burst tripped a limit.
    for (const chunk of failedChunks) {
      await sleep(1000);
      await runChunk(chunk);
    }

    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// Download every cached pair currently in Redis (dist:v1:*). Read-only.
export async function GET() {
  try {
    const records = await exportCachedDistances();
    return NextResponse.json({ count: records.length, records });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
