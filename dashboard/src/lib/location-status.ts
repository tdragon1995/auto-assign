/**
 * Disable / re-enable a client location in BOTH systems.
 *
 * Labcenter owns whether the customer portal still offers the place
 * (`is_active`). Cartrack has no such flag, so the convention the fleet already
 * uses is a name prefix — "{inactive} 21362 - TBinh - …" — which every reader of
 * the Location and config tabs sees, and which the config table sorts last.
 *
 * Order: Labcenter first. It is the side a customer sees, so if only one write
 * lands, the portal has at least stopped offering the place. Both writes are
 * idempotent (a side already in the target state is left alone), so a partial
 * result is fixed by pressing the button again rather than by hand.
 */
import { getCustomerById, renameCustomer } from "./cartrack";
import {
  getAdminToken, getCartrackCustomerId, listLocationsByClientCode, setLocationActive,
} from "./labcenter";
import { sbSelect, supabaseConfigured } from "./supabase-rest";

export const INACTIVE_PREFIX = /^\s*\{inactive\}\s*/i;
export const isInactiveName = (name: string) => INACTIVE_PREFIX.test(name);
export const stripInactive = (name: string) => name.replace(INACTIVE_PREFIX, "");
export const withInactive = (name: string) => `{inactive} ${stripInactive(name)}`;

/** The Labcenter client code a Cartrack name starts with ("25372 - MTho - …" →
 *  "25372"), or null for names that carry none (BRA, 3PL, "Other"). */
export function clientCodeOf(name: string): string | null {
  const m = /^(\d{3,})\s*-/.exec(stripInactive(name).trim());
  return m ? m[1] : null;
}

/** How many of a client's locations to open one by one while looking for the
 *  linked one. A client has a handful; the cap only bounds a pathological one. */
const MAX_CANDIDATES = 30;

/**
 * The Labcenter location linked to a Cartrack customer.
 *
 * Cheapest first: `pickup_setup` already holds the pairing for every place the
 * ETA panel has resolved. Otherwise the client code in the name narrows Labcenter
 * to that client's few locations, and each is opened until one links back to
 * this customer. Matching is always on the LINK, never on the name.
 */
async function findLabcenterId(customerId: string, name: string, token: string): Promise<number | null> {
  if (supabaseConfigured()) {
    const hit = await sbSelect<{ lc_location_id: number }>(
      "pickup_setup", `select=lc_location_id&pick_id=eq.${encodeURIComponent(customerId)}&limit=1`,
    ).catch(() => []);
    if (hit[0]) return hit[0].lc_location_id;
  }
  const code = clientCodeOf(name);
  if (!code) return null;
  const candidates = (await listLocationsByClientCode(code, token, false)).slice(0, MAX_CANDIDATES);
  for (const loc of candidates) {
    if ((await getCartrackCustomerId(loc.id, token)) === customerId) return loc.id;
  }
  return null;
}

export interface LocationStatusResult {
  ok: boolean;
  /** One side written and the other not — pressing again finishes it. */
  partial?: boolean;
  error?: string;
  name?: string;
  lcLocationId?: number;
}

export async function setLocationStatus(customerId: string, active: boolean): Promise<LocationStatusResult> {
  const current = await getCustomerById(customerId);
  const name: string | undefined = current?.data?.customer_name;
  if (!name) return { ok: false, error: "Không đọc được địa điểm từ Cartrack" };

  const token = await getAdminToken();
  if (!token) return { ok: false, error: "Không đăng nhập được Labcenter (LABCENTER_EMAIL/LABCENTER_PASSWORD)" };

  const lcLocationId = await findLabcenterId(customerId, name, token);
  if (lcLocationId == null) {
    // Refused rather than done on Cartrack alone: a renamed Cartrack place that
    // the portal still offers is the one outcome worse than doing nothing.
    return { ok: false, error: `Không tìm thấy địa điểm Labcenter nối với "${stripInactive(name)}"`, name };
  }

  const lc = await setLocationActive(lcLocationId, active, token);
  if (!lc.ok) return { ok: false, error: lc.error, name, lcLocationId };

  const target = active ? stripInactive(name) : withInactive(name);
  const ct = await renameCustomer(customerId, target);
  if (!ct.ok) {
    return {
      ok: false, partial: true, name, lcLocationId,
      error: `Labcenter đã ${active ? "mở lại" : "ngưng"}, nhưng Cartrack chưa đổi tên: ${ct.error}. Bấm lại để hoàn tất.`,
    };
  }
  return { ok: true, name: target, lcLocationId };
}
