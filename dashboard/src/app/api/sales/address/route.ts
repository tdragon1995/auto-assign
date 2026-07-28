import { NextRequest, NextResponse } from "next/server";
import { updateCustomerAddress, type Env } from "@/lib/cartrack";
import { getAdminToken, getCartrackCustomerId, updateLocationAddress } from "@/lib/labcenter";

export const runtime = "edge";
export const preferredRegion = "sin1";

// ── PUT /api/sales/address — update a location's address + GPS in both systems ─
//
// Like the phone update, the address lives in two places and both move together:
// Cartrack's customer (drivers + auto-assign route on its coordinates) and the
// Labcenter location (the client-facing address). They're joined via the
// location's cartrack_vn integration link. Cartrack needs a full-record PUT (a
// partial one is ignored for address); Labcenter takes a direct address PUT.

export async function PUT(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const body = await req.json();
    const { location_id, address_line_1, latitude, longitude } = body as {
      location_id?: number;
      address_line_1?: string;
      latitude?: number;
      longitude?: number;
    };

    if (typeof location_id !== "number") {
      return NextResponse.json({ error: "Missing location_id" }, { status: 400 });
    }
    if (!address_line_1?.trim()) {
      return NextResponse.json({ error: "Thiếu địa chỉ" }, { status: 400 });
    }
    if (typeof latitude !== "number" || typeof longitude !== "number") {
      return NextResponse.json({ error: "Thiếu toạ độ — chọn địa chỉ từ gợi ý" }, { status: 400 });
    }
    const address = address_line_1.trim();

    const token = await getAdminToken();
    if (!token) return NextResponse.json({ error: "Labcenter login failed" }, { status: 502 });

    // Resolve the Cartrack customer before writing anything, so a location with
    // no cartrack_vn link fails cleanly instead of leaving the two sides split.
    const customerId = await getCartrackCustomerId(location_id, token);
    if (!customerId) {
      return NextResponse.json(
        { error: "Địa điểm này chưa được liên kết với Cartrack — không thể cập nhật." },
        { status: 409 },
      );
    }

    const cartrack = await updateCustomerAddress(
      customerId,
      { address_line_1: address, latitude, longitude },
      env,
    );
    const labcenter = await updateLocationAddress(location_id, { address, latitude, longitude }, token);

    if (cartrack.ok && labcenter.ok) {
      return NextResponse.json({ success: true, address_line_1: address, latitude, longitude, cartrack, labcenter });
    }

    // Partial failure — the two systems now disagree. Say which side landed so
    // the user knows a retry is needed rather than assuming it all worked.
    return NextResponse.json(
      { error: "Cập nhật chưa hoàn tất — vui lòng thử lại.", address_line_1: address, latitude, longitude, cartrack, labcenter },
      { status: 502 },
    );
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
