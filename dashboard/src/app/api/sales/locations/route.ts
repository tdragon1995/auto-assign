import { NextRequest, NextResponse } from "next/server";
import { updateCustomerPhone, type Env } from "@/lib/cartrack";
import {
  getAdminToken,
  getCartrackCustomerId,
  listLocationsByClientCode,
  updateLocationPhone,
} from "@/lib/labcenter";

export const runtime = "edge";
export const preferredRegion = "sin1";

// A contact number must be plausibly dialable. Existing rows are inconsistent
// (some stored without the leading 0), so accept 9–11 digits rather than
// enforcing a stricter shape that would reject legitimate edits.
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 11) return null;
  return digits;
}

// ── GET /api/sales/locations?client_code=… — locations for one client ────────

export async function GET(req: NextRequest) {
  const clientCode = req.nextUrl.searchParams.get("client_code")?.trim();
  if (!clientCode) return NextResponse.json({ error: "Missing client_code" }, { status: 400 });

  const token = await getAdminToken();
  if (!token) {
    return NextResponse.json(
      { error: "Labcenter login failed (check LABCENTER_EMAIL/LABCENTER_PASSWORD)" },
      { status: 502 },
    );
  }

  try {
    const locations = await listLocationsByClientCode(clientCode, token);
    return NextResponse.json({
      locations: locations.map((l) => ({
        id: l.id,
        name: l.name,
        phone: l.phone,
        address: l.address,
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

// ── PUT /api/sales/locations — update the contact phone in both systems ──────
//
// The phone lives in two places and both must move together: Labcenter's
// location.phone (shown in the client interface) and Cartrack's
// customer.contact_number (what drivers see on the job). They are joined via
// the location's cartrack_vn integration link.

export async function PUT(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const body = await req.json();
    const { location_id, phone } = body as { location_id?: number; phone?: string };

    if (typeof location_id !== "number") {
      return NextResponse.json({ error: "Missing location_id" }, { status: 400 });
    }
    const normalized = normalizePhone(phone ?? "");
    if (!normalized) {
      return NextResponse.json({ error: "Số điện thoại không hợp lệ" }, { status: 400 });
    }

    const token = await getAdminToken();
    if (!token) {
      return NextResponse.json({ error: "Labcenter login failed" }, { status: 502 });
    }

    // Resolve the Cartrack customer before writing anything, so a location with
    // no cartrack_vn link fails cleanly instead of leaving the two sides split.
    const customerId = await getCartrackCustomerId(location_id, token);
    if (!customerId) {
      return NextResponse.json(
        { error: "Địa điểm này chưa được liên kết với Cartrack — không thể cập nhật." },
        { status: 409 },
      );
    }

    const labcenter = await updateLocationPhone(location_id, normalized, token);
    const cartrack = await updateCustomerPhone(customerId, normalized, env);

    if (labcenter.ok && cartrack.ok) {
      return NextResponse.json({ success: true, phone: normalized, labcenter, cartrack });
    }

    // Partial failure — the two systems now disagree. Say which one landed so
    // the user knows a retry is needed rather than assuming it all worked.
    return NextResponse.json(
      {
        error: "Cập nhật chưa hoàn tất — vui lòng thử lại.",
        phone: normalized,
        labcenter,
        cartrack,
      },
      { status: 502 },
    );
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
