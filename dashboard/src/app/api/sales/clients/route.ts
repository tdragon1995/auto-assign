import { NextRequest, NextResponse } from "next/server";
import { searchManagedClients } from "@/lib/labcenter";
import { salesUser } from "@/lib/sales-session";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

// GET /api/sales/clients?q= — the signed-in rep's own clients only.
// (/api/labcenter/client stays unscoped for the admin dashboard.)
export async function GET(req: NextRequest) {
  const user = salesUser(req);
  if (!user) return NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });

  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2) return NextResponse.json({ results: [] });

  try {
    return NextResponse.json({ results: await searchManagedClients(user.email, q) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
