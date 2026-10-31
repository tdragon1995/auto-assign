import { sbSelectAll } from "./supabase-rest";
import { readConfigGen } from "./config-gen";
import { PSC_ROUTES } from "./psc-routes-data";

export const PSC_TINH_LABEL = "🛵 Vận chuyển mẫu tỉnh";
// Cartrack customer "3PL - Nhà Xe Thanh Tĩnh" (was Nhà Xe Đình Nhân 43cc0fee-…, 306a Hồng Lạc, until 2026-10-27).
export const DANANG_PICKUP_UUID = "e904a4f0-d1da-11f1-9378-fa163ee8d8ac";
export const DANANG_PICKUP_NAME = "3PL - Nhà Xe Thanh Tĩnh";
export const DANANG_PICKUP_ADDRESS = "121 Nguyễn Hữu Tiến, Tây Thạnh";

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

// TPL entries change rarely; cache for 5 min (or until the config stamp moves) so
// the provincial page's 3PL dropdown and the orders fallback don't re-read on every request.
const TPL_CACHE_MS = 5 * 60 * 1000;
let _tplCache: TplEntry[] | null = null;
let _tplCacheAt = 0;
let _tplGen: string | null = null;

/** Busts the TPL-entries cache (PSC routes are hard-coded — [[psc-routes-data]] — so
 *  this is all there is to bust). Wired to the dashboard Refresh button via /api/config. */
export function invalidatePscCache() {
  _tplCache = null;
  _tplCacheAt = 0;
}

export async function loadTplEntries(): Promise<TplEntry[]> {
  const gen = await readConfigGen();
  if (_tplCache && gen === _tplGen && Date.now() - _tplCacheAt < TPL_CACHE_MS) return _tplCache;
  const entries = await sbSelectAll<TplEntry>("master_tpl_entries", "select=psc_tinh,tpl_name,tpl_uuid,address&active=eq.true", "id.asc");
  _tplCache = entries; _tplCacheAt = Date.now(); _tplGen = gen;
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

