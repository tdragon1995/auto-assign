// Labcenter API client — shared login + location helpers.
//
// Two separate accounts are in play:
//   • admin (LABCENTER_EMAIL)        — spc-delivery: locations, pick/drop mappings.
//   • receptionist (LABCENTER_RECEPTIONIST_*) — spc-pos: client search.
// Most spc-delivery endpoints require the DELIVERY_ADMIN role, so they must use
// the admin account; the receptionist token gets a 403 there.

const LOGIN_URL = "https://api-bknd.labcenter.vn/api/v1/auth/login";
export const DELIVERY_BASE = "https://api.labcenter.vn/spc-delivery";

export const CARTRACK_INTEGRATION_CODE = "cartrack_vn";

type TokenCache = { token: string; expiresAt: number };
const caches: Record<string, TokenCache | null> = { admin: null, receptionist: null };
const logins: Partial<Record<"admin" | "receptionist", Promise<string | null>>> = {};

function login(kind: "admin" | "receptionist", rejectedToken?: string): Promise<string | null> {
  if (rejectedToken && caches[kind]?.token === rejectedToken) caches[kind] = null;
  const cached = caches[kind];
  if (cached && cached.expiresAt > Date.now() + 60_000) return Promise.resolve(cached.token);
  return logins[kind] ??= freshLogin(kind).finally(() => { delete logins[kind]; });
}

async function freshLogin(kind: "admin" | "receptionist"): Promise<string | null> {
  const now = Date.now();

  const email =
    kind === "admin" ? process.env.LABCENTER_EMAIL : process.env.LABCENTER_RECEPTIONIST_EMAIL;
  const password =
    kind === "admin" ? process.env.LABCENTER_PASSWORD : process.env.LABCENTER_RECEPTIONIST_PASSWORD;
  if (!email || !password) return null;

  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, "g-recaptcha-response": "randString" }),
  });
  if (!res.ok) return null;

  const data = await res.json().catch(() => ({}));
  const token: string | undefined = data?.token;
  if (!token) return null;

  let expiresAt = now + 60 * 60 * 1000;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (payload?.exp) expiresAt = payload.exp * 1000;
  } catch { /* keep default */ }

  caches[kind] = { token, expiresAt };
  return token;
}

export const getAdminToken = () => login("admin");
export const getReceptionistToken = () => login("receptionist");

export class LabcenterAuthenticationError extends Error {
  constructor() { super("Labcenter từ chối phiên đăng nhập sau khi thử đăng nhập lại (401); đồng bộ đã dừng, dữ liệu hiện có được giữ nguyên"); }
}

/** Renew a rejected session once; concurrent requests share the same login. */
export async function labcenterFetch(url: string, init: RequestInit, kind: "admin" | "receptionist" = "admin"): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = await login(kind) ?? headers.get("Authorization")?.replace(/^Bearer /, "");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let res = await fetch(url, { ...init, headers });
  if (res.status !== 401) return res;
  const renewed = await login(kind, token);
  if (renewed) {
    headers.set("Authorization", `Bearer ${renewed}`);
    res = await fetch(url, { ...init, headers });
  }
  if (res.status === 401) throw new LabcenterAuthenticationError();
  return res;
}

// --- Delivery requests (the SPC queue Labcenter shows its dispatchers) ---

/** One row of GET /api/delivery-requests. Only the fields the ETA sync reads are
 *  typed; the payload carries far more (attachments, hbc_path, branch_id, …). */
export interface DeliveryRequest {
  id: number;
  code: string;
  status: string;
  /** Which fleet system owns the job — "cartrack_vn" for everything we can trace. */
  delivery_integration_code: string | null;
  /** The Cartrack job_id, as a string. THE join key between the two systems. */
  delivery_integration_request_id: string | null;
  from_name: string | null;
  to_name: string | null;
  created_at: string | null;
  accepted_at: string | null;
  started_at: string | null;
  pickup_completed_at: string | null;
  completed_at: string | null;
  expected_assign_at: string | null;
  estimate_assign_at: string | null;
}

export interface DeliveryRequestQuery {
  /** UTC instants bounding created_at, formatted "YYYY-MM-DDTHH:mm:ss+00:00". */
  fromCreatedAt: string;
  toCreatedAt: string;
  lateOverStatus: string;
  lateOverMin: number;
}

/** GET /api/delivery-requests — paginated; follows pages until a short one.
 *
 *  The response carries no usable `meta` (observed `{}`), so pagination is inferred
 *  from a full page rather than a total count. Capped at MAX_PAGES so a server that
 *  ignores `page` can't spin this forever. */
const PER_PAGE = 50;
const MAX_PAGES = 20;

export async function listDeliveryRequests(
  q: DeliveryRequestQuery,
  token: string,
): Promise<DeliveryRequest[]> {
  const out: DeliveryRequest[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      from_created_at: q.fromCreatedAt,
      to_created_at: q.toCreatedAt,
      late_over_status: q.lateOverStatus,
      late_over_min: String(q.lateOverMin),
      page: String(page),
      perPage: String(PER_PAGE),
    });
    const res = await labcenterFetch(`${DELIVERY_BASE}/api/delivery-requests?${params}`, {
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Labcenter delivery-requests ${res.status}`);
    const rows: DeliveryRequest[] = (await res.json().catch(() => ({})))?.data ?? [];
    out.push(...rows);
    if (rows.length < PER_PAGE) break;
  }
  return out;
}

/** PATCH /api/delivery-requests/{id}/update-expected-assign — publishes how many
 *  minutes from now the driver is expected to reach the pickup. */
export async function updateExpectedAssign(
  requestId: number,
  minutes: number,
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await labcenterFetch(
    `${DELIVERY_BASE}/api/delivery-requests/${requestId}/update-expected-assign`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ expected_assign_minute: minutes }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true };
}

export type LabcenterLocation = {
  id: number;
  name: string;
  new_name: string | null;
  phone: string;
  phone_code: string;
  address: string;
  client_code: string;
  is_active: boolean;
};

type IntegrationLink = {
  delivery_integration_code: string;
  delivery_integration_location_id: string;
};

// GET /api/locations?client_code=… — active locations for one client.
export async function listLocationsByClientCode(
  clientCode: string,
  token: string,
): Promise<LabcenterLocation[]> {
  const params = new URLSearchParams({
    client_code: clientCode,
    is_active: "true",
    page: "1",
    perPage: "100",
  });
  const res = await labcenterFetch(`${DELIVERY_BASE}/api/locations?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Labcenter locations ${res.status}`);
  const data = await res.json().catch(() => ({}));
  return data?.data ?? [];
}

// GET /api/locations/{id} — detail carries the integration links and mappings.
// NOTE: the key is `delivery_integration_locations` (snake_case). The vendor
// docs call it `deliveryIntegrationLocations`; that name is not in the payload.
export async function getCartrackCustomerId(
  locationId: number,
  token: string,
): Promise<string | null> {
  const res = await labcenterFetch(`${DELIVERY_BASE}/api/locations/${locationId}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  const links: IntegrationLink[] = data?.data?.delivery_integration_locations ?? [];
  return (
    links.find((l) => l.delivery_integration_code === CARTRACK_INTEGRATION_CODE)
      ?.delivery_integration_location_id ?? null
  );
}

// PUT /api/locations/{id} — partial update (verified: sending only `phone`
// leaves name/address/coords intact).
export async function updateLocationPhone(
  locationId: number,
  phone: string,
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await labcenterFetch(`${DELIVERY_BASE}/api/locations/${locationId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true };
}

// PUT /api/locations/{id} — update address + coordinates directly. Verified on
// external (client) locations including linked ones; Vietnamese text round-trips
// so long as the body is proper UTF-8 (fetch + JSON.stringify — a Windows `curl`
// with inline UTF-8 mangles it and the API no-ops with a 200, which is what
// earlier made this look read-only). Read-back confirms rather than trusting 200.
export async function updateLocationAddress(
  locationId: number,
  addr: { address: string; latitude: number; longitude: number },
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await labcenterFetch(`${DELIVERY_BASE}/api/locations/${locationId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ address: addr.address, latitude: addr.latitude, longitude: addr.longitude }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  const check = await labcenterFetch(`${DELIVERY_BASE}/api/locations/${locationId}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (check.ok) {
    const d = (await check.json().catch(() => ({})))?.data;
    if (d && d.address !== addr.address) {
      return { ok: false, error: "Labcenter nhận yêu cầu nhưng không cập nhật địa chỉ" };
    }
  }
  return { ok: true };
}

// --- Pick-drop setup (default drop-off + portal ETA per pickup place) ---

/** One row of the pick-drop setup, flattened. Keyed by LABCENTER location ids —
 *  the write endpoint below takes Cartrack UUIDs instead, and
 *  getCartrackCustomerId is the bridge between the two. */
export interface PickDropRow {
  lc_location_id: number;
  pick_name: string | null;
  drop_location_id: number;
  drop_name: string | null;
  eta_mins: number;
  eta_valid?: boolean;
  eta_blank?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPickDropRow(r: any): PickDropRow | null {
  const pick = Number(r?.pick_location_id);
  const drop = r?.drop_location_id == null || String(r.drop_location_id).trim() === "" ? 0 : Number(r.drop_location_id);
  if (!Number.isFinite(pick) || !Number.isFinite(drop)) return null;
  return {
    lc_location_id: pick,
    pick_name: r?.pick_location?.name ?? null,
    drop_location_id: drop,
    drop_name: r?.drop_location?.name ?? null,
    eta_mins: Number(r?.estimate_pick_up) || 0,
    eta_blank: r?.estimate_pick_up == null || String(r.estimate_pick_up).trim() === "",
    eta_valid: r?.estimate_pick_up != null && String(r.estimate_pick_up).trim() !== "" && Number.isFinite(Number(r.estimate_pick_up)),
  };
}

/** GET /api/pick-drop-locations, every page (~2,100 rows = 5 pages at 500). The
 *  response carries no total, so a short page is the last one. */
export async function listPickDropLocations(token: string, pickLocationId?: number): Promise<PickDropRow[]> {
  const out: PickDropRow[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await labcenterFetch(`${DELIVERY_BASE}/api/pick-drop-locations?page=${page}&perPage=500${pickLocationId === undefined ? "" : `&pick_location_id=${pickLocationId}`}`, {
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Labcenter pick-drop-locations ${res.status}`);
    const rows: unknown[] = (await res.json().catch(() => ({})))?.data ?? [];
    for (const r of rows) {
      const row = toPickDropRow(r);
      if (row) out.push(row);
    }
    if (rows.length < 500) break;
  }
  return out;
}

/** POST /api/locations/update-pick-drop-location — sets a place's default drop-off
 *  and portal ETA. Takes CARTRACK ids. Labcenter answers 200 to writes it discards
 *  (see updateLocationAddress), so the row is read back by its Labcenter pick id
 *  (`?pick_location_id=` does filter — verified) before this reports success. */
export async function updatePickDropLocation(
  w: { pickId: string; dropId: string; etaMins: number; lcLocationId: number; dropLocationId: number; expectedEtaMins?: number },
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const source = (await listPickDropLocations(token, w.lcLocationId)).filter(r=>r.lc_location_id===w.lcLocationId);
  if (source.some(r=>r.drop_location_id!==source[0].drop_location_id || r.eta_mins!==source[0].eta_mins)) {
    return {ok:false,error:"Labcenter có nhiều điểm giao/ETA cho địa điểm này; cần xử lý bản ghi trùng trước khi đồng bộ"};
  }
  if (w.expectedEtaMins !== undefined) {
    const current = source[0];
    if (!current?.eta_valid || current.eta_mins !== w.expectedEtaMins || current.drop_location_id !== w.dropLocationId) {
      return { ok: false, error: "Labcenter setup changed; refresh before updating ETA" };
    }
  }
  const res = await labcenterFetch(`${DELIVERY_BASE}/api/locations/update-pick-drop-location`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({ pick_id: w.pickId, drop_id: w.dropId, estimate_pick_up: w.etaMins }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  const check = await labcenterFetch(`${DELIVERY_BASE}/api/pick-drop-locations?pick_location_id=${w.lcLocationId}&perPage=5`, {
    headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!check.ok) return { ok: false, error: `Không đọc lại được Labcenter (HTTP ${check.status})` };
  const rows: unknown[] = (await check.json().catch(() => ({})))?.data ?? [];
  const now = rows.map(toPickDropRow).find((r) => r?.lc_location_id === w.lcLocationId);
  if (!now || now.eta_mins !== w.etaMins || now.drop_location_id !== w.dropLocationId) {
    return { ok: false, error: "Labcenter nhận yêu cầu nhưng không cập nhật" };
  }
  return { ok: true };
}
