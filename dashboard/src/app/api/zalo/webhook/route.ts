import { NextRequest, NextResponse } from "next/server";
import { sendZaloMessage } from "@/lib/zalo";
import { HELP, parseCommand, buildStatsReply, botToken, allowedChats } from "@/lib/kiot-bot";
import { KiotAuthError } from "@/lib/kiotviet";

// ── POST /api/zalo/webhook?key=<secret> ──────────────────────────────────────
// Zalo Bot Platform pushes updates here (register with setWebhook — see .env.example).
// Replies with KiotViet revenue + order count on command.
//
// Two independent gates, because the payload is revenue data:
//   1. `key` (or x-zalo-secret) must match ZALO_KIOT_WEBHOOK_SECRET — stops anyone
//      who guesses the URL from POSTing fake updates.
//   2. The sender's chat_id must be in ZALO_KIOT_ALLOWED_CHATS — the real control,
//      since Zalo itself forwards messages from *any* user who finds the bot, and
//      those arrive with a perfectly valid secret. Gate 1 can't distinguish them.
// An unconfigured allowlist replies with the chat's own id and nothing else, so
// setup is self-serve without ever leaking figures to an unknown chat.

/** Zalo sends `message.text.received`; tolerate a bare Telegram-style update too. */
interface ZaloUpdate {
  event_name?: string;
  message?: {
    text?: string;
    chat?: { id?: string | number };
  };
}

export async function POST(req: NextRequest) {
  // Gate 1 — shared secret. Fail closed if it isn't configured at all.
  const expected = process.env.ZALO_KIOT_WEBHOOK_SECRET;
  const provided = req.nextUrl.searchParams.get("key") ?? req.headers.get("x-zalo-secret");
  if (!expected || provided !== expected) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const token = botToken();
  if (!token) {
    console.error("[zalo-webhook] no bot token configured");
    return NextResponse.json({ ok: true });
  }

  let update: ZaloUpdate;
  try {
    update = (await req.json()) as ZaloUpdate;
  } catch {
    return NextResponse.json({ ok: true });
  }

  // Ignore non-text events (images, stickers, joins) — nothing to answer.
  if (update.event_name && update.event_name !== "message.text.received") {
    return NextResponse.json({ ok: true });
  }

  const text = update.message?.text ?? "";
  const chatId = update.message?.chat?.id != null ? String(update.message.chat.id) : "";
  if (!chatId) return NextResponse.json({ ok: true });

  // Gate 2 — chat allowlist. Unconfigured: hand back the id so setup is self-serve.
  const allowed = allowedChats();
  if (allowed.length === 0) {
    await sendZaloMessage(
      token,
      chatId,
      `⚙️ Bot chưa được cấp quyền cho nhóm này.\nChat ID: ${chatId}\n\nThêm id này vào ZALO_KIOT_ALLOWED_CHATS rồi deploy lại.`
    );
    return NextResponse.json({ ok: true });
  }
  if (!allowed.includes(chatId)) {
    console.warn("[zalo-webhook] rejected chat", chatId);
    await sendZaloMessage(token, chatId, "⛔ Nhóm này không có quyền xem doanh thu.");
    return NextResponse.json({ ok: true });
  }

  const cmd = parseCommand(text);
  if (cmd.kind === "ignore") return NextResponse.json({ ok: true });

  let reply: string;
  if (cmd.kind === "help") {
    reply = HELP;
  } else if (cmd.kind === "id") {
    reply = `Chat ID: ${chatId}`;
  } else {
    try {
      reply = await buildStatsReply(cmd.date);
    } catch (e) {
      // A stale session token is the expected failure here — name it plainly in
      // chat rather than reporting 0đ, which would read as a real (bad) sales day.
      reply =
        e instanceof KiotAuthError
          ? `🔑 Không lấy được số liệu: ${e.message}\nCần cập nhật thông tin đăng nhập KiotViet.`
          : "⚠️ Lỗi khi lấy số liệu từ KiotViet. Thử lại sau ít phút.";
      console.error("[zalo-webhook] stats failed", e);
    }
  }

  await sendZaloMessage(token, chatId, reply);
  return NextResponse.json({ ok: true });
}

// Health check — confirms the route is deployed without exposing anything.
export async function GET() {
  return NextResponse.json({ ok: true, service: "zalo-kiotviet-bot" });
}
