import { NextRequest, NextResponse } from "next/server";
import { sendZaloMessage } from "@/lib/zalo";
import { buildDailyPushReply, botToken, allowedChats, PARSE_MODE } from "@/lib/kiot-bot";
import { KiotAuthError } from "@/lib/kiotviet";

export const runtime = "nodejs";
export const maxDuration = 30;

// ── GET /api/zalo/daily-report ───────────────────────────────────────────────
// Scheduled push of the day's revenue so far. Vercel Cron fires this at 09:00 UTC
// = 16:00 Asia/Ho_Chi_Minh (see vercel.json — Vercel schedules are always UTC).
// Goes to the same chats allowed to ask on demand.

/** Same shape as /api/assign/cron: open when CRON_SECRET is unset, so a manual
 *  browser hit still works for testing. */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization");
  const header = req.headers.get("x-cron-secret");
  return auth === `Bearer ${secret}` || header === secret;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = botToken();
  const chats = allowedChats();
  if (!token || chats.length === 0) {
    console.error("[daily-report] missing bot token or chat list");
    return NextResponse.json({ ok: false, reason: "not configured" }, { status: 200 });
  }

  let text: string;
  try {
    text = await buildDailyPushReply();
  } catch (e) {
    // Say the token died rather than pushing 0đ, which reads as a real bad day.
    text =
      e instanceof KiotAuthError
        ? `🔑 Không lấy được doanh thu hôm nay: ${e.message}\nCần cập nhật thông tin đăng nhập KiotViet.`
        : "⚠️ Lỗi khi lấy số liệu từ KiotViet cho báo cáo chiều.";
    console.error("[daily-report] stats failed", e);
  }

  // ?dry=1 exercises everything except the send — KiotViet fetch, formatting, and
  // which chats would receive it. Testing the real endpoint means posting a genuine
  // revenue report into a live group, which is a poor way to find out you had the
  // wrong chat id.
  if (req.nextUrl.searchParams.get("dry") === "1") {
    return NextResponse.json({ ok: true, dryRun: true, wouldSendTo: chats, message: text });
  }

  // One slow/failed chat must not stop the rest from getting the report.
  const results = await Promise.all(
    chats.map(async (chat) => ({ chat, sent: await sendZaloMessage(token, chat, text, PARSE_MODE) }))
  );

  return NextResponse.json({
    ok: true,
    sent: results.filter((r) => r.sent).length,
    failed: results.filter((r) => !r.sent).map((r) => r.chat),
  });
}
