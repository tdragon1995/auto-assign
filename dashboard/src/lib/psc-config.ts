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

// TPL entries change rarely; cache for 5 min so the provincial page's 3PL dropdown
// and the orders fallback don't re-download the sheet CSV on every request.
const TPL_CACHE_MS = 5 * 60 * 1000;
let _tplCache: TplEntry[] | null = null;
let _tplCacheAt = 0;

/** Busts the TPL-entries cache (PSC routes are hard-coded — [[psc-routes-data]] — so
 *  this is all there is to bust). Wired to the dashboard Refresh button via /api/config. */
export function invalidatePscCache() {
  _tplCache = null;
  _tplCacheAt = 0;
}

export async function loadTplEntries(): Promise<TplEntry[]> {
  if (_tplCache && Date.now() - _tplCacheAt < TPL_CACHE_MS) return _tplCache;

  const rows = await fetchSheetRows(SHEET_GID.tpl);
  const entries = rows
    .filter((r) => r["psc-tinh"] && r["3pl_uuid"])
    .map((r) => ({
      psc_tinh: r["psc-tinh"] ?? "",
      tpl_name: r["3pl"] ?? "",
      tpl_uuid: r["3pl_uuid"] ?? "",
      address: r["address"] ?? "",
    }));

  // Never cache an empty result — a transient bad sheet fetch would otherwise stick
  // for 5 min (the same failure mode as the config-cache footgun in CLAUDE.md #3).
  if (entries.length > 0) {
    _tplCache = entries;
    _tplCacheAt = Date.now();
  }
  return entries;
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

