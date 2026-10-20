import { NextRequest, NextResponse } from "next/server";
import { draftRedis } from "@/lib/ao-print-draft";
import { exclusionsOf } from "@/lib/handover";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

// One shared list, no expiry: it changes by hand, a few times a month.
const KEY = "ao:hardcopy:exclusions";

export async function GET() {
  const db = draftRedis();
  if (!db) return NextResponse.json({ error: "Danh sách loại trừ chưa được cấu hình" }, { status: 503 });
  try {
    return NextResponse.json({ list: exclusionsOf(await db.get(KEY)) ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[ao/exclusions] read", error);
    return NextResponse.json({ error: "Không tải được danh sách loại trừ" }, { status: 502 });
  }
}

/** Replaces the whole list. */
export async function PUT(req: NextRequest) {
  const db = draftRedis();
  if (!db) return NextResponse.json({ error: "Danh sách loại trừ chưa được cấu hình" }, { status: 503 });
  const list = exclusionsOf((await req.json().catch(() => null))?.list);
  if (!list) return NextResponse.json({ error: "Danh sách loại trừ không hợp lệ" }, { status: 400 });
  try {
    await db.set(KEY, list);
    return NextResponse.json({ list });
  } catch (error) {
    console.error("[ao/exclusions] save", error);
    return NextResponse.json({ error: "Không lưu được danh sách loại trừ" }, { status: 502 });
  }
}
