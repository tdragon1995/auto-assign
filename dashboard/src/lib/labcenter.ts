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

async function login(kind: "admin" | "receptionist"): Promise<string | null> {
  const now = Date.now();
  const cached = caches[kind];
  if (cached && cached.expiresAt > now + 60_000) return cached.token;

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
  const res = await fetch(`${DELIVERY_BASE}/api/locations?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
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
  const res = await fetch(`${DELIVERY_BASE}/api/locations/${locationId}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
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
  const res = await fetch(`${DELIVERY_BASE}/api/locations/${locationId}`, {
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
