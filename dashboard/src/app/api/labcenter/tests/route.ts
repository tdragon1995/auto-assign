import { NextRequest, NextResponse } from "next/server";
import { getReceptionistToken } from "@/lib/labcenter";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

// The POS test catalogue as one client sees it. Needs the receptionist role, like /api/labcenter/orders.
const TESTS_URL = "https://api.labcenter.vn/spc-pos/api/test-master";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  const account = req.nextUrl.searchParams.get("account_code")?.trim();
  if (!q || q.length < 2 || !account) return NextResponse.json({ results: [] });

  const token = await getReceptionistToken();
  if (!token) return NextResponse.json({ error: "Labcenter login failed" }, { status: 502 });

  const res = await fetch(`${TESTS_URL}?q=${encodeURIComponent(q)}&account_code=${encodeURIComponent(account)}&limit=30`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) return NextResponse.json({ error: `Labcenter ${res.status}` }, { status: 502 });

  const data = await res.json().catch(() => ({}));
  const results = (Array.isArray(data?.data) ? data.data : []).map((t: Record<string, unknown>) => ({
    code: String(t.test_code ?? ""),
    // Every name the order may carry it under — billing_name, test_name, test_name_vi.
    names: [...new Set([t.billing_name, t.test_name, t.test_name_vi].map((v) => String(v ?? "").trim()).filter(Boolean))],
  })).filter((t: { code: string; names: string[] }) => t.code && t.names.length);

  return NextResponse.json({ results });
}
