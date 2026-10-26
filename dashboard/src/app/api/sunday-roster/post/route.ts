import { NextRequest, NextResponse } from "next/server";
import { isSunday } from "@/lib/sunday-roster";
import { vnDate } from "@/lib/time";
import { loadSundayLines, postWeekly, previewImageUrls } from "@/lib/sunday-roster-zalo";
import { stageFor, STAGE_LABEL, weeklyPostText, type Stage } from "@/lib/sunday-roster-post";

export const runtime = "nodejs";
export const preferredRegion = "sin1";
export const maxDuration = 60;

// The drivers' post on demand, from Lịch Chủ nhật: GET shows what would go out
// (both pictures + the text, as a page), POST sends it to the drivers' groups
// now. The cron's own Wednesday/Friday posts are unaffected.

const stageOf = (raw: unknown, date: string): Stage =>
  raw === "draft" || raw === "final" ? raw : stageFor(vnDate(), date);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date");
  if (!isSunday(date)) return NextResponse.json({ error: "Ngày phải là Chủ nhật" }, { status: 400 });
  const stage = stageOf(req.nextUrl.searchParams.get("stage"), date);
  const lines = await loadSundayLines(date);
  const images = previewImageUrls(date, lines, stage), text = weeklyPostText(date, lines, stage);
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Xem trước — Lịch CN ${esc(date)}</title>
<style>body{margin:0;padding:16px;background:#f1f5f9;font:15px/1.5 system-ui,sans-serif;color:#0f172a}main{max-width:760px;margin:0 auto}
h1{font-size:18px;margin:0 0 4px}p{margin:0 0 16px;color:#475569}img{display:block;width:100%;height:auto;margin:0 0 16px;border-radius:8px;background:#fff}
pre{white-space:pre-wrap;background:#fff;border-radius:8px;padding:16px;margin:0}</style></head>
<body><main><h1>Xem trước bài đăng — Chủ nhật ${esc(date)} · ${esc(STAGE_LABEL[stage])}</h1>
<p>Thứ tự gửi lên mỗi nhóm tài xế: ${images.length} ảnh, rồi tin nhắn. Ảnh được vẽ khi mở trang này (vài giây).</p>
${images.map((u) => `<img src="${esc(u)}" alt="">`).join("\n")}
<pre>${esc(text)}</pre></main></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const date = body?.date;
  if (!isSunday(date)) return NextResponse.json({ error: "Ngày phải là Chủ nhật" }, { status: 400 });
  const res = await postWeekly(date, stageOf(body?.stage, date));
  if (!res.ok) return NextResponse.json({ error: `Chưa đăng được: ${res.reason}` }, { status: 502 });
  return NextResponse.json({ ok: true });
}
