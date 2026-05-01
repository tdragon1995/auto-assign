import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, type Env } from "@/lib/cartrack";
import { loadPscRoutes } from "@/lib/psc-config";
import { haversineKm } from "@/lib/distance";

export const runtime = "edge";
export const preferredRegion = "sin1";
const COUNTRY_ID = 235;
const DEFAULT_CONTACT_CODE = "84";
const LABCENTER_URL = "https://api.labcenter.vn/spc-delivery/api/locations/update-pick-drop-location";
const LABCENTER_LOGIN_URL = "https://api-bknd.labcenter.vn/api/v1/auth/login";

let labcenterTokenCache: { token: string; expiresAt: number } | null = null;

async function getLabcenterToken(): Promise<string | null> {
  const now = Date.now();
  if (labcenterTokenCache && labcenterTokenCache.expiresAt > now + 60_000) {
    return labcenterTokenCache.token;
  }
  const email = process.env.LABCENTER_EMAIL;
  const password = process.env.LABCENTER_PASSWORD;
  if (!email || !password) return null;

  const res = await fetch(LABCENTER_LOGIN_URL, {
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

  labcenterTokenCache = { token, expiresAt };
  return token;
}

async function registerLabcenterPickDrop(pickUuid: string, lat: number, lon: number): Promise<{ ok: boolean; drop_id?: string; error?: string }> {
  const token = await getLabcenterToken();
  if (!token) return { ok: false, error: "Labcenter login failed (check LABCENTER_EMAIL/LABCENTER_PASSWORD)" };

  const routes = await loadPscRoutes();
  const seen = new Set<string>();
  let nearest: { uuid: string; km: number } | null = null;
  for (const r of routes) {
    if (!r.pickup || r.lat == null || r.lon == null) continue;
    if (seen.has(r.pickup)) continue;
    seen.add(r.pickup);
    const km = haversineKm(lat, lon, r.lat, r.lon);
    if (!nearest || km < nearest.km) nearest = { uuid: r.pickup, km };
  }
  if (!nearest) return { ok: false, error: "No PSC with coordinates found" };

  const res = await fetch(LABCENTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ pick_id: pickUuid, drop_id: nearest.uuid, estimate_pick_up: 60 }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, drop_id: nearest.uuid, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true, drop_id: nearest.uuid };
}

// ── GET /api/customers?name=... — check duplicate by exact customer_name ─────

export async function GET(req: NextRequest) {
  const env  = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const name = req.nextUrl.searchParams.get("name")?.trim();

  if (!name) return NextResponse.json({ error: "Missing name" }, { status: 400 });

  try {
    const headers = getHeaders(env);
    const lower = name.toLowerCase();
    let page = 1;
    const limit = 1000;
    let match: { customer_id: string; customer_name: string } | null = null;

    while (page <= 20) {
      const res = await fetch(`${BASE_URL}/customers?page=${page}&limit=${limit}`, { headers, cache: "no-store" });
      if (!res.ok) break;
      const data = await res.json();
      const rows: { customer_id: string; customer_name: string }[] = data.data ?? [];
      if (rows.length === 0) break;

      const hit = rows.find((r) => (r.customer_name ?? "").trim().toLowerCase() === lower);
      if (hit) { match = hit; break; }

      if (rows.length < limit) break;
      page += 1;
    }

    return NextResponse.json({ duplicate: !!match, match });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── POST /api/customers — create new customer ────────────────────────────────

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const body = await req.json();
    const {
      customer_name,
      address_line_1,
      latitude,
      longitude,
      contact_number,
    } = body as {
      customer_name: string;
      address_line_1?: string;
      latitude?: number;
      longitude?: number;
      contact_number?: string;
    };

    if (!customer_name) {
      return NextResponse.json({ error: "Missing customer_name" }, { status: 400 });
    }

    const headers = getHeaders(env);

    // Duplicate guard — exact match on customer_name
    const lower = customer_name.trim().toLowerCase();
    let page = 1;
    while (page <= 20) {
      const res = await fetch(`${BASE_URL}/customers?page=${page}&limit=1000`, { headers, cache: "no-store" });
      if (!res.ok) break;
      const data = await res.json();
      const rows: { customer_id: string; customer_name: string }[] = data.data ?? [];
      if (rows.length === 0) break;
      const hit = rows.find((r) => (r.customer_name ?? "").trim().toLowerCase() === lower);
      if (hit) {
        return NextResponse.json({ error: "Khách hàng đã tồn tại", match: hit }, { status: 409 });
      }
      if (rows.length < 1000) break;
      page += 1;
    }

    const payload: Record<string, unknown> = {
      customer_name,
      country_id: COUNTRY_ID,
      contact_code: DEFAULT_CONTACT_CODE,
      contact_number: contact_number || "0",
    };
    if (address_line_1) payload.address_line_1 = address_line_1;
    if (latitude != null && longitude != null) {
      payload.latitude = latitude;
      payload.longitude = longitude;
    }

    const createRes = await fetch(`${BASE_URL}/customers`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({}));
      return NextResponse.json({ error: "Tạo khách hàng thất bại", details: err }, { status: createRes.status });
    }

    const created = await createRes.json();
    const customer = created.data;

    let labcenter: { ok: boolean; drop_id?: string; error?: string } | null = null;
    if (customer?.customer_id && latitude != null && longitude != null) {
      try {
        labcenter = await registerLabcenterPickDrop(customer.customer_id, latitude, longitude);
      } catch (e) {
        labcenter = { ok: false, error: String(e) };
      }
    }

    return NextResponse.json({ success: true, customer, labcenter });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
