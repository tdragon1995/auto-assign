import { NextRequest, NextResponse } from "next/server";
import { draftRedis, printRowOf, readPrintHistory, savePrintHistory } from "@/lib/ao-print-draft";
import type { PrintDraftRow } from "@/lib/handover";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

export async function GET() {
  const db = draftRedis();
  if (!db) return NextResponse.json({ error: "Lịch sử in chưa được cấu hình" }, { status: 503 });
  try {
    return NextResponse.json({ prints: await readPrintHistory(db) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[ao/prints] read", error);
    return NextResponse.json({ error: "Không tải được lịch sử in" }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const db = draftRedis();
  if (!db) return NextResponse.json({ error: "Lịch sử in chưa được cấu hình" }, { status: 503 });
  if (Number(req.headers.get("content-length") ?? 0) > 1_000_000) return NextResponse.json({ error: "Dữ liệu quá lớn" }, { status: 413 });
  const body = await req.json().catch(() => null);
  const rawRows: unknown[] | null = Array.isArray(body?.rows) ? body.rows : null;
  const rows = rawRows?.map(printRowOf);
  if (typeof body?.title !== "string" || !["D001", "Ngoài D001"].includes(body.title)
    || !rows?.length || rows.length > 500 || !rows.every((row): row is PrintDraftRow => row !== null)) {
    return NextResponse.json({ error: "Bản in không hợp lệ" }, { status: 400 });
  }
  try {
    return NextResponse.json({ print: await savePrintHistory(db, body.title, rows) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[ao/prints] save", error);
    return NextResponse.json({ error: "Không lưu được lịch sử in" }, { status: 502 });
  }
}
