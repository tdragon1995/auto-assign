import { NextRequest, NextResponse } from "next/server";
import { isSunday } from "@/lib/sunday-roster";
import { vnDate } from "@/lib/time";
import { postWeekly } from "@/lib/sunday-roster-zalo";
import { stageFor } from "@/lib/sunday-roster-post";

export const runtime = "nodejs";
export const preferredRegion = "sin1";
export const maxDuration = 60;

// POST { date, stage? } — Lịch Chủ nhật's "Gửi thử": the exact drivers' post
// (both pictures + text) sent to the ADMIN group only, marked as a test. Its own
// path on purpose: a deploy that predates it answers 404 instead of sending to
// the drivers.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const date = body?.date;
  if (!isSunday(date)) return NextResponse.json({ error: "Ngày phải là Chủ nhật" }, { status: 400 });
  const stage = body?.stage === "draft" || body?.stage === "final" ? body.stage : stageFor(vnDate(), date);
  const res = await postWeekly(date, stage, { test: true });
  if (!res.ok) return NextResponse.json({ error: `Chưa gửi được: ${res.reason}` }, { status: 502 });
  return NextResponse.json({ ok: true, stage });
}
