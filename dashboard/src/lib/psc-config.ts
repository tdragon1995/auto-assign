import { fetchSheetRows, SHEET_GID } from "./sheets";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const PSC_TINH_LABEL = "🛵 Vận chuyển mẫu tỉnh";

export interface PscRoute {
  psc_pickup: string;
  dropoff_location: string;
  pickup: string;
  dropoff: string;
  ref_number: string;
  lat: number | null;
  lon: number | null;
}

export interface TplEntry {
  psc_tinh: string;
  tpl_name: string;
  tpl_uuid: string;
  address: string;
}

// ── In-memory cache ──────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  ts: number;
}

let routesCache: CacheEntry<PscRoute[]> | null = null;

function isFresh<T>(entry: CacheEntry<T> | null): entry is CacheEntry<T> {
  return entry !== null && Date.now() - entry.ts < CACHE_TTL_MS;
}

/** Called by dashboard Refresh button to bust the cache */
export function invalidatePscCache() {
  routesCache = null;
}

export async function loadTplEntries(): Promise<TplEntry[]> {
  const rows = await fetchSheetRows(SHEET_GID.tpl);

  return rows
    .filter((r) => r["psc-tinh"] && r["3pl_uuid"])
    .map((r) => ({
      psc_tinh: r["psc-tinh"] ?? "",
      tpl_name: r["3pl"] ?? "",
      tpl_uuid: r["3pl_uuid"] ?? "",
      address: r["address"] ?? "",
    }));
}

export async function loadPscRoutes(): Promise<PscRoute[]> {
  if (isFresh(routesCache)) return routesCache.data;

  const rows = await fetchSheetRows(SHEET_GID.psc);

  const data = rows
    .filter((r) => r["psc_pickup"] && r["pickup"])
    .map((r) => ({
      psc_pickup: r["psc_pickup"] ?? "",
      dropoff_location: r["dropoff_location"] ?? "",
      pickup: r["pickup"] ?? "",
      dropoff: r["dropoff"] ?? "",
      ref_number: r["ref_number"] ?? "",
      lat: r["lat"] ? parseFloat(r["lat"]) : null,
      lon: r["long"] ? parseFloat(r["long"]) : null,
    }));

  routesCache = { data, ts: Date.now() };
  return data;
}

