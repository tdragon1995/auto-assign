import { NextRequest, NextResponse } from "next/server";
import { getPickupReply } from "@/lib/scheduled-pickup-cancel";
import { SAMPLE_PICKUP_CUSTOMER_ID } from "@/lib/scheduled-pickup-reminder";
import { sendZaloMessage } from "@/lib/zalo";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

type Update = {
  event_name?: string;
  message?: {
    text?: string;
    chat?: { id?: string | number; chat_type?: string };
    from?: { is_bot?: boolean };
  };
};

export async function POST(req: NextRequest) {
  const secret = process.env.ZALO_SAMPLE_WEBHOOK_SECRET;
  if (!secret || req.headers.get("x-bot-api-secret-token") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let update: Update;
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") return NextResponse.json({ ok: true });
    update = body.result ?? body;
    if (!update || typeof update !== "object") return NextResponse.json({ ok: true });
  }
  catch { return NextResponse.json({ ok: true }); }

  console.info("[zalo-sample] received", {
    event: update.event_name,
    chatId: update.message?.chat?.id,
    chatType: update.message?.chat?.chat_type,
  });

  if (update.event_name !== "message.text.received" || update.message?.from?.is_bot) {
    return NextResponse.json({ ok: true });
  }
  const chat = update.message?.chat;
  const chatId = chat?.id == null ? "" : String(chat.id);
  if (!chatId || chat?.chat_type !== "GROUP") return NextResponse.json({ ok: true });

  const token = process.env.ZALO_SAMPLE_BOT_TOKEN;
  if (!token) return NextResponse.json({ ok: true });
  const text = typeof update.message?.text === "string" ? update.message.text : "";

  // Setup command: the group can reveal its own chat ID before it is allowlisted.
  if (!process.env.ZALO_SAMPLE_CHAT_ID && /^(?:@.+?\s+)?\/id(?:\s+@.+)?$/i.test(text.trim())) {
    const sent = await sendZaloMessage(token, chatId, `Chat ID: ${chatId}`);
    if (!sent) console.error("[zalo-sample] chat ID reply failed", { chatId });
    return NextResponse.json({ ok: true });
  }
  if (chatId !== process.env.ZALO_SAMPLE_CHAT_ID) {
    return NextResponse.json({ ok: true });
  }

  const reply = await getPickupReply(SAMPLE_PICKUP_CUSTOMER_ID, text, chatId);
  if (reply) await sendZaloMessage(token, chatId, reply);
  return NextResponse.json({ ok: true });
}
