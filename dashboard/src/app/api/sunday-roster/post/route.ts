import { NextRequest, NextResponse } from "next/server";
import { isSunday } from "@/lib/sunday-roster";
import { imageUrl, loadSundayLines, postWeekly } from "@/lib/sunday-roster-zalo";
import { weeklyPostText } from "@/lib/sunday-roster-post";

export const runtime = "nodejs";
export const preferredRegion = "sin1";
export const maxDuration = 30;

// The Friday post on demand, from Lịch Chủ nhật: GET previews what would go
// out (text + picture link), POST sends it to the drivers' group now. The
// cron's own Friday post is unaffected — it still goes out once at 17:00.

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date");
  if (!isSunday(date)) return NextResponse.json({ error: "Ngày phải là Chủ nhật" }, { status: 400 });
  return NextResponse.json({ text: weeklyPostText(date, await loadSundayLines(date)), image: imageUrl(date) });
}

export async function POST(req: NextRequest) {
  const date = (await req.json().catch(() => null))?.date;
  if (!isSunday(date)) return NextResponse.json({ error: "Ngày phải là Chủ nhật" }, { status: 400 });
  const res = await postWeekly(date);
  if (!res.ok) return NextResponse.json({ error: `Chưa đăng được: ${res.reason}` }, { status: 502 });
  return NextResponse.json({ ok: true });
}
