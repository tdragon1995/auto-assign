import { NextRequest, NextResponse } from "next/server";
import { type Env } from "@/lib/cartrack";

export const runtime = "edge";
export const preferredRegion = "sin1";

const BASE_URL = "https://fleetapi-vn.cartrack.com/rest/delivery";
const COUNTRY_ID = 235;
const DEFAULT_CONTACT_CODE = "84";

function getHeaders(env: Env = "prod"): Record<string, string> {
  const suffix = env === "uat" ? "_UAT" : "";
  const auth = process.env[`CARTRACK_AUTH${suffix}`] ?? "";
  const cookie = process.env[`CARTRACK_COOKIE${suffix}`] ?? "";
  if (!auth) throw new Error(`CARTRACK_AUTH${suffix} not set`);
  const headers: Record<string, string> = { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" };
  if (cookie) headers["Cookie"] = cookie;
  return headers;
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
      contact_code,
      contact_number,
    } = body as {
      customer_name: string;
      address_line_1?: string;
      latitude?: number;
      longitude?: number;
      contact_code?: string;
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
      contact_code: contact_code || DEFAULT_CONTACT_CODE,
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
    return NextResponse.json({ success: true, customer: created.data });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
