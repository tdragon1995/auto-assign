import { fetchSheetRows, SHEET_GID } from "./sheets";

export const PSC_TINH_LABEL = "🛵 Vận chuyển mẫu tỉnh";

export interface PscRoute {
  psc_pickup: string;
  dropoff_location: string;
  pickup: string;
  dropoff: string;
  ref_number: string;
  lat: number | null;
  lon: number | null;
  /** Via-route: customer_id of an intermediate PSC the driver stops at en route (e.g. D046).
   *  Empty for normal routes. Drives the pinned via-leg + pickup-stop to-do. */
  via_pickup: string;
  /** Display name of the via PSC, for to-do text and the via-leg reference. */
  via_pickup_name: string;
  /** When true, the QR page hides the request tab — location does not accept self-requests. */
  no_request: boolean;
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
}

let routesCache: CacheEntry<PscRoute[]> | null = null;

function isFresh<T>(entry: CacheEntry<T> | null): entry is CacheEntry<T> {
  return entry !== null;
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
      via_pickup: r["via_pickup"] ?? "",
      via_pickup_name: r["via_pickup_name"] ?? "",
      no_request: r["no_request"]?.toUpperCase() === "TRUE",
    }));

  routesCache = { data };
  return data;
}

