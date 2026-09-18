import { NextRequest, NextResponse } from "next/server";
import { getReceptionistToken } from "@/lib/labcenter";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

// Needs the receptionist-nurse-phlebotomist role — the delivery-admin account 403s here.
const ORDERS_URL = "https://api.labcenter.vn/spc-pos/api/orders";
const MAX_VIDS = 100;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const vids = [...new Set(
    (Array.isArray(body?.vids) ? body.vids : []).map((v: unknown) => String(v).replace(/\D/g, "")).filter(Boolean),
  )] as string[];
  if (!vids.length) return NextResponse.json({ error: "Chưa có VID" }, { status: 400 });
  if (vids.length > MAX_VIDS) return NextResponse.json({ error: `Tối đa ${MAX_VIDS} VID mỗi lần` }, { status: 400 });

  const token = await getReceptionistToken();
  if (!token) return NextResponse.json({ error: "Labcenter login failed" }, { status: 502 });

  // ponytail: unbounded parallelism under the 100 cap; add a pool if Labcenter starts 429ing.
  const results = await Promise.all(vids.map(async (vid) => {
    try {
      const res = await fetch(`${ORDERS_URL}?visit_number=${vid}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (res.status === 403) return { vid, error: "Tài khoản chưa có quyền xem đơn" };
      if (res.status === 404) return { vid, error: "Không tìm thấy" };
      if (!res.ok) return { vid, error: `Labcenter ${res.status}` };
      const o = (await res.json().catch(() => ({})))?.data;
      if (!o?.branch_code && !o?.client_id) return { vid, error: "Không tìm thấy" };
      return {
        vid,
        branch_code: o.branch_code ?? null,
        client_id: o.client_id != null ? String(o.client_id) : null,
        client_name: o.client_name?.trim() || null,
      };
    } catch {
      return { vid, error: "Không kết nối được Labcenter" };
    }
  }));

  return NextResponse.json({ results });
}
