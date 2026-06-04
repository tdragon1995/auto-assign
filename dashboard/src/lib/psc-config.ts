import { fetchSheetRows, SHEET_GID } from "./sheets";
import { PSC_ROUTES } from "./psc-routes-data";

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

/** No-op: PSC routes are hard-coded ([[psc-routes-data]]), so there's no cache to bust.
 *  Kept so the dashboard Refresh button (/api/config) keeps its import. */
export function invalidatePscCache() {}

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

/**
 * Load PSC routes — returns the hard-coded table ([[psc-routes-data]]).
 *
 * No sheet fetch, cache, or CDN: the data is baked into the deployment, so it's identical
 * across every Vercel instance and runtime and propagates only via deploy. Kept async (and
 * returning a copy) so callers and the signature are unchanged.
 */
export async function loadPscRoutes(): Promise<PscRoute[]> {
  return [...PSC_ROUTES];
}

