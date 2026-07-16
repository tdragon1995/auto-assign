import { NextRequest, NextResponse } from "next/server";
import { getReceptionistToken } from "@/lib/labcenter";

export const runtime = "edge";
export const preferredRegion = "sin1";

const CLIENT_URL = "https://api.labcenter.vn/spc-pos/api/client";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2) return NextResponse.json({ results: [] });

  const token = await getReceptionistToken();
  if (!token) return NextResponse.json({ error: "Labcenter login failed" }, { status: 502 });

  const res = await fetch(`${CLIENT_URL}?q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return NextResponse.json({ error: `Labcenter ${res.status}` }, { status: 502 });

  const data = await res.json().catch(() => ({}));
  const results = (data?.data ?? []).map((c: { code: string; client_legal_name: string }) => ({
    code: c.code,
    client_legal_name: c.client_legal_name?.trim() ?? "",
  }));

  return NextResponse.json({ results });
}
