import { NextRequest, NextResponse } from "next/server";
import { listPrints, printRowOf, readPrint, savePrint } from "@/lib/ao-print-draft";
import type { PrintDraftRow } from "@/lib/handover";
import { supabaseConfigured } from "@/lib/supabase-rest";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

export async function GET(req: NextRequest) {
  if (!supabaseConfigured()) return NextResponse.json({ error: "Lịch sử in chưa được cấu hình" }, { status: 503 });
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (id) {
      const print = await readPrint(id);
      return NextResponse.json(print ? { print } : { error: "Không tìm thấy bản in" }, {
        status: print ? 200 : 404, headers: { "Cache-Control": "no-store" },
      });
    }
    // ?vid= narrows the list to the prints that carried that VID (any part of it, 4+ digits).
    const vid = req.nextUrl.searchParams.get("vid")?.trim();
    if (vid && !/^\d{4,32}$/.test(vid)) return NextResponse.json({ error: "VID không hợp lệ" }, { status: 400 });
    return NextResponse.json({ prints: await listPrints(vid) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[ao/prints] read", error);
    return NextResponse.json({ error: "Không tải được lịch sử in" }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  if (!supabaseConfigured()) return NextResponse.json({ error: "Lịch sử in chưa được cấu hình" }, { status: 503 });
  if (Number(req.headers.get("content-length") ?? 0) > 2_000_000) return NextResponse.json({ error: "Dữ liệu quá lớn" }, { status: 413 });
  const body = await req.json().catch(() => null);
  const rawRows: unknown[] | null = Array.isArray(body?.rows) ? body.rows : null;
  const rows = rawRows?.map(printRowOf);
  if (typeof body?.title !== "string" || !["D001", "Ngoài D001"].includes(body.title)
    || !rows?.length || rows.length > 2000 || !rows.every((row): row is PrintDraftRow => row !== null)) {
    return NextResponse.json({ error: "Bản in không hợp lệ" }, { status: 400 });
  }
  try {
    const printId = typeof body.id === "string" && /^[0-9a-f-]{36}$/i.test(body.id) ? body.id : undefined;
    return NextResponse.json({ print: await savePrint(body.title, rows, printId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[ao/prints] save", error);
    return NextResponse.json({ error: "Không lưu được lịch sử in" }, { status: 502 });
  }
}
