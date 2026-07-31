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

// Zalo's bot settings screen has its own "Secret Token" field, which it sends as a
// request header — but the header name isn't documented, so accept the handful of
// plausible spellings alongside our own. The `?key=` query param is the mechanism we
// can actually guarantee, so it stays the primary one; these are belt-and-braces for
// whichever header Zalo turns out to use.
const SECRET_HEADERS = [
  "x-zalo-secret",
  "x-bot-api-secret-token",
  "x-zalo-bot-api-secret-token",
  "secret-token",
  "secret_token",
];

/** The secret presented by the caller, from the query string or any known header. */
function presentedSecret(req: NextRequest): string | null {
  const fromQuery = req.nextUrl.searchParams.get("key");
  if (fromQuery) return fromQuery;
  for (const h of SECRET_HEADERS) {
    const v = req.headers.get(h);
    if (v) return v;
  }
  return null;
}

export async function POST(req: NextRequest) {
  // Gate 1 — shared secret. Fail closed if it isn't configured at all.
  const expected = process.env.ZALO_KIOT_WEBHOOK_SECRET;
  const provided = presentedSecret(req);
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
    // Include the chat's own id: it isn't sensitive (the chat already "is" that id)
    // and it's the only practical way to discover the id of a NEW group you want to
    // allow, since an allowlisted-but-wrong-group otherwise just gets a flat refusal.
    await sendZaloMessage(
      token,
      chatId,
      `⛔ Nhóm này không có quyền xem doanh thu.\nChat ID: ${chatId}\n\nThêm id này vào ZALO_KIOT_ALLOWED_CHATS nếu muốn cấp quyền.`
    );
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
