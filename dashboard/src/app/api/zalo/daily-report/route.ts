import { NextRequest, NextResponse } from "next/server";
import { sendZaloMessage } from "@/lib/zalo";
import { buildDailyPushReply, botToken, allowedChats, PARSE_MODE } from "@/lib/kiot-bot";
import { KiotAuthError } from "@/lib/kiotviet";

export const runtime = "nodejs";
export const maxDuration = 30;

// ── GET /api/zalo/daily-report ───────────────────────────────────────────────
// Scheduled push of the day's revenue so far, fired at 09:00 UTC = 16:00
// Asia/Ho_Chi_Minh by .github/workflows/kiotviet-daily-report.yml.
// Goes to the same chats allowed to ask on demand.

/** ZALO_REPORT_SECRET is preferred over CRON_SECRET so this endpoint can be re-keyed
 *  on its own. CRON_SECRET also guards /api/assign/cron, and the external cron-job.org
 *  ping presents it on every call — changing that value stops the assign engine dead,
 *  with no error anywhere except jobs quietly not being assigned. Falls back to
 *  CRON_SECRET so existing deployments keep working, and stays open if neither is set. */
function authorized(req: NextRequest): boolean {
  const secret = (process.env.ZALO_REPORT_SECRET || process.env.CRON_SECRET || "").trim();
  if (!secret) return true;
  return (
    req.headers.get("authorization") === `Bearer ${secret}` ||
    req.headers.get("x-cron-secret") === secret ||
    // Query param too, so the dry run can be opened straight in a browser.
    req.nextUrl.searchParams.get("key") === secret
  );
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
