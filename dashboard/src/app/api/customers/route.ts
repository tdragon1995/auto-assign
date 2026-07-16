import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, type Env } from "@/lib/cartrack";
import { DELIVERY_BASE, getAdminToken } from "@/lib/labcenter";
import { loadPscRoutes } from "@/lib/psc-config";
import { haversineKm } from "@/lib/distance";

export const runtime = "edge";
export const preferredRegion = "sin1";
const COUNTRY_ID = 235;
const DEFAULT_CONTACT_CODE = "84";
const LABCENTER_URL = `${DELIVERY_BASE}/api/locations/update-pick-drop-location`;

// Two same-named locations closer together than this are the same place.
const DUPLICATE_BLOCK_RADIUS_M = 100;

type DuplicateMatch = {
  customer_id: string;
  customer_name: string;
  address_line_1?: string;
  latitude?: number | string | null;
  longitude?: number | string | null;
};

// Metres from an existing customer to the new coordinates, or null when the
// existing row has no usable coordinates (can't judge proximity — don't block).
function matchDistanceM(m: DuplicateMatch, lat: number, lon: number): number | null {
  const mLat = typeof m.latitude === "string" ? parseFloat(m.latitude) : m.latitude;
  const mLon = typeof m.longitude === "string" ? parseFloat(m.longitude) : m.longitude;
  if (mLat == null || mLon == null || Number.isNaN(mLat) || Number.isNaN(mLon)) return null;
  if (mLat === 0 && mLon === 0) return null;
  return haversineKm(lat, lon, mLat, mLon) * 1000;
}

async function registerLabcenterPickDrop(pickUuid: string, lat: number, lon: number): Promise<{ ok: boolean; drop_id?: string; error?: string }> {
  const token = await getAdminToken();
  if (!token) return { ok: false, error: "Labcenter login failed (check LABCENTER_EMAIL/LABCENTER_PASSWORD)" };

  const routes = await loadPscRoutes();
  const seen = new Set<string>();
  let nearest: { uuid: string; km: number } | null = null;
  for (const r of routes) {
    if (!r.pickup || r.lat == null || r.lon == null) continue;
    if (seen.has(r.pickup)) continue;
    seen.add(r.pickup);
    // Exclude BRA - D000 from the nearest-PSC search (depot, not a real drop-off).
    const code = r.psc_pickup.replace(/^BRA\s*-\s*/i, "").trim().toUpperCase();
    if (code === "D000") continue;
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
      force,
      check_prefix,
      client_code,
    } = body as {
      customer_name: string;
      address_line_1?: string;
      latitude?: number;
      longitude?: number;
      contact_number?: string;
      force?: boolean;
      check_prefix?: string;
      client_code?: string;
    };

    if (!customer_name) {
      return NextResponse.json({ error: "Missing customer_name" }, { status: 400 });
    }

    const headers = getHeaders(env);

    // Duplicate guard. One pass over the customer list feeds two checks:
    //
    //  • prefixMatches (maKh - quanCu - street) drives the name warning, which
    //    force=true may waive — a real second branch on the same street.
    //  • codeMatches (same client code, any district/street) drives the 100m
    //    block below. Matching on the code rather than the full prefix is
    //    deliberate: a survey of live data found 9 duplicate pairs sitting 0–58m
    //    apart that a prefix match missed, because the district or street
    //    abbreviation differed (e.g. "21555 - TDuc - 48" vs "21555 - TDuc -
    //    HBinh", 0m apart). The code is what identifies the client.
    //
    // The scan runs even when force=true; force must not waive the 100m rule,
    // or the block would be one click away from useless.
    const prefix = (check_prefix?.trim() ?? customer_name.trim()).toLowerCase();
    const code = (client_code ?? customer_name.split(" - ")[0]).trim();
    const matches: DuplicateMatch[] = [];
    const codeMatches: DuplicateMatch[] = [];
    let page = 1;
    while (page <= 20) {
      const res = await fetch(`${BASE_URL}/customers?page=${page}&limit=1000`, { headers, cache: "no-store" });
      if (!res.ok) break;
      const data = await res.json();
      const rows: DuplicateMatch[] = data.data ?? [];
      if (rows.length === 0) break;
      for (const r of rows) {
        const name = (r.customer_name ?? "").trim();
        if (name.toLowerCase().startsWith(prefix)) matches.push(r);
        // Exact first-segment match — startsWith would let "2155" hit "21555".
        if (code && name.split(" - ")[0].trim() === code) codeMatches.push(r);
      }
      if (rows.length < 1000) break;
      page += 1;
    }

    // Hard block — the same client already has a location within 100m, so this
    // is the same physical place, not another branch. Unforceable. Only
    // decidable with coordinates; the form requires them before it can submit.
    if (latitude != null && longitude != null) {
      const tooClose = codeMatches
        .map((m) => ({ match: m, distance_m: matchDistanceM(m, latitude, longitude) }))
        .filter((x): x is { match: DuplicateMatch; distance_m: number } => x.distance_m != null)
        .filter((x) => x.distance_m <= DUPLICATE_BLOCK_RADIUS_M)
        .sort((a, b) => a.distance_m - b.distance_m);

      if (tooClose.length > 0) {
        return NextResponse.json(
          {
            error: `Khách hàng này đã có địa điểm cách đây dưới ${DUPLICATE_BLOCK_RADIUS_M}m — không thể tạo trùng.`,
            blocked: true,
            matches: tooClose.map((x) => ({ ...x.match, distance_m: Math.round(x.distance_m) })),
          },
          { status: 409 },
        );
      }
    }

    if (!force && matches.length > 0) {
      return NextResponse.json({ error: "Khách hàng đã tồn tại", matches }, { status: 409 });
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
