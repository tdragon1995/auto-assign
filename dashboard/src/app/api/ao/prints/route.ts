import { NextRequest, NextResponse } from "next/server";
import { deletePrintHistoryItem, draftRedis, printRowOf, readPrintHistory, readPrintHistoryItem, savePrintHistory } from "@/lib/ao-print-draft";
import type { PrintDraftRow } from "@/lib/handover";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

export async function GET(req: NextRequest) {
  const db = draftRedis();
  if (!db) return NextResponse.json({ error: "Lịch sử in chưa được cấu hình" }, { status: 503 });
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (id) {
      const print = await readPrintHistoryItem(db, id);
      return NextResponse.json(print ? { print } : { error: "Không tìm thấy bản in" }, {
        status: print ? 200 : 404, headers: { "Cache-Control": "no-store" },
      });
    }
    const prints = (await readPrintHistory(db)).map(({ id, printedAt, title, rows }) => ({ id, printedAt, title, count: rows.length }));
    return NextResponse.json({ prints }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[ao/prints] read", error);
    return NextResponse.json({ error: "Không tải được lịch sử in" }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const db = draftRedis();
  if (!db) return NextResponse.json({ error: "Lịch sử in chưa được cấu hình" }, { status: 503 });
  if (Number(req.headers.get("content-length") ?? 0) > 2_000_000) return NextResponse.json({ error: "Dữ liệu quá lớn" }, { status: 413 });
  const body = await req.json().catch(() => null);
  const rawRows: unknown[] | null = Array.isArray(body?.rows) ? body.rows : null;
  const rows = rawRows?.map(printRowOf);
  if (typeof body?.title !== "string" || !["D001", "Ngoài D001"].includes(body.title)
    || !rows?.length || rows.length > 2000 || !rows.every((row): row is PrintDraftRow => row !== null)) {
    return NextResponse.json({ error: "Bản in không hợp lệ" }, { status: 400 });
  }
  try {
    const { id, printedAt, title, rows: savedRows } = await savePrintHistory(db, body.title, rows);
    return NextResponse.json({ print: { id, printedAt, title, count: savedRows.length } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[ao/prints] save", error);
    return NextResponse.json({ error: "Không lưu được lịch sử in" }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const db = draftRedis();
  if (!db) return NextResponse.json({ error: "Lịch sử in chưa được cấu hình" }, { status: 503 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Mã bản in không hợp lệ" }, { status: 400 });
  try {
    const deleted = await deletePrintHistoryItem(db, id);
    return NextResponse.json(deleted ? { deleted: true } : { error: "Không tìm thấy bản in" }, {
      status: deleted ? 200 : 404, headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[ao/prints] delete", error);
    return NextResponse.json({ error: "Không xóa được bản in" }, { status: 502 });
  }
}
