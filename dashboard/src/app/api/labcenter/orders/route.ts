import { NextRequest, NextResponse } from "next/server";
import { getReceptionistToken } from "@/lib/labcenter";
import { destFromRemark } from "@/lib/handover";

export const runtime = "nodejs";
export const preferredRegion = "sin1";
export const maxDuration = 60;

// Needs the receptionist-nurse-phlebotomist role — the delivery-admin account 403s here.
const ORDERS_URL = "https://api.labcenter.vn/spc-pos/api/orders";
const MAX_VIDS = 100;
const CONCURRENCY = 10;

async function fetchOrder(vid: string, token: string, retry = true): Promise<Response> {
  const res = await fetch(`${ORDERS_URL}?visit_number=${vid}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (retry && (res.status === 429 || res.status >= 500)) {
    await new Promise((r) => setTimeout(r, 1000));
    return fetchOrder(vid, token, false);
  }
  return res;
}

async function lookup(vid: string, token: string) {
  try {
    const res = await fetchOrder(vid, token);
    if (res.status === 403) return { vid, error: "Tài khoản chưa có quyền xem đơn" };
    if (res.status === 404) return { vid, error: "Không tìm thấy" };
    if (!res.ok) return { vid, error: `Labcenter ${res.status}` };
    const o = (await res.json().catch(() => ({})))?.data;
    if (!o?.branch_code && !o?.client_id) return { vid, error: "Không tìm thấy" };
    // Only HBC orders carry a hard-copy destination in the remark; every other branch keeps its own.
    // Read Ghi chú (remarks) and Bệnh sử (history) together — staff type the sentence into either.
    const notes = [...new Set([o.remarks, o.history].map((v) => String(v ?? "").trim()).filter(Boolean))];
    const remark = o.branch_code === "HBC" ? notes.join(" | ") || null : null;
    const fromRemark = destFromRemark(remark);
    return {
      vid,
      branch_code: o.branch_code ?? null,
      client_id: o.client_id != null ? String(o.client_id) : null,
      client_name: o.client_name?.trim() || null,
      patient_name: o.patient_full_name?.trim() || null,
      // Every name a test goes by — a pasted name is checked against all of them.
      test_names: [...new Set(
        (Array.isArray(o.order_test_details) ? o.order_test_details : [])
          .flatMap((t: Record<string, unknown>) => [t.billing_name, t.test_name, t.test_name_vi])
          .map((v: unknown) => String(v ?? "").trim()).filter(Boolean),
      )],
      remark,
      // Where the paper result goes: for HBC, the branch its remark names; otherwise the order's branch.
      dest: fromRemark ?? o.branch_code ?? null,
      dest_from_remark: !!fromRemark,
    };
  } catch {
    return { vid, error: "Không kết nối được Labcenter" };
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const vids = [...new Set(
    (Array.isArray(body?.vids) ? body.vids : []).map((v: unknown) => String(v).replace(/\D/g, "")).filter(Boolean),
  )] as string[];
  if (!vids.length) return NextResponse.json({ error: "Chưa có VID" }, { status: 400 });
  if (vids.length > MAX_VIDS) return NextResponse.json({ error: `Tối đa ${MAX_VIDS} VID mỗi lần` }, { status: 400 });

  const token = await getReceptionistToken();
  if (!token) return NextResponse.json({ error: "Labcenter login failed" }, { status: 502 });

  const results: Awaited<ReturnType<typeof lookup>>[] = new Array(vids.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < vids.length) {
      const i = next++;
      results[i] = await lookup(vids[i], token);
    }
  }));

  return NextResponse.json({ results });
}
