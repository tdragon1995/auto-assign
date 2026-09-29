import wards from "@/data/wards.json";
import { haversineKm } from "./distance";
import { PSC_ROUTES } from "./psc-routes-data";

export const GEO_DATASET_VERSION = "wards-2026-09-28/psc-v1";

type Point = [number, number];
type Ward = { n: string; p: string; c: Point[][][] };
const indexed = (wards as Ward[]).flatMap((ward) => ward.c.map((polygon) => {
  const xs = polygon[0].map((p) => p[0]), ys = polygon[0].map((p) => p[1]);
  return { ward, polygon, minLon: Math.min(...xs), maxLon: Math.max(...xs), minLat: Math.min(...ys), maxLat: Math.max(...ys) };
}));

function insideRing(lon: number, lat: number, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[j];
    if ((ay > lat) !== (by > lat) && lon < ((bx - ax) * (lat - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

export function newWard(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const { ward, polygon, minLon, maxLon, minLat, maxLat } of indexed) {
    if (lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat &&
        insideRing(lon, lat, polygon[0]) &&
        !polygon.slice(1).some((hole) => insideRing(lon, lat, hole))) {
      return `${ward.n}, ${ward.p}`;
    }
  }
  return null;
}

export async function nearestPsc(lat: number, lon: number) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best: { id: string; name: string; km: number } | null = null;
  const seen = new Set<string>();
  for (const r of PSC_ROUTES) {
    if (!r.pickup || r.lat == null || r.lon == null || seen.has(r.pickup)) continue;
    seen.add(r.pickup);
    if (r.psc_pickup.replace(/^BRA\s*-\s*/i, "").trim().toUpperCase() === "D000") continue;
    const km = haversineKm(lat, lon, r.lat, r.lon);
    if (!best || km < best.km) best = { id: r.pickup, name: r.psc_pickup, km };
  }
  return best;
}
