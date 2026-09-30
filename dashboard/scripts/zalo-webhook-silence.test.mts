import assert from "node:assert/strict";
import { NextRequest } from "next/server";

process.env.ZALO_KIOT_WEBHOOK_SECRET = "mock-secret";
process.env.ZALO_KIOT_BOT_TOKEN = "mock-bot";
process.env.ZALO_KIOT_ALLOWED_CHATS = "zgr-authorized";

const { POST } = await import("../src/app/api/zalo/webhook/route");
const originalFetch = globalThis.fetch;
const sent: string[] = [];
globalThis.fetch = async (_input, init) => {
  sent.push(String(init?.body));
  return Response.json({ ok: true });
};

const request = (chatId: string, text: string) => new NextRequest(
  "https://example.test/api/zalo/webhook?key=mock-secret",
  { method: "POST", body: JSON.stringify({ event_name: "message.text.received", message: { chat: { id: chatId }, text } }) },
);

try {
  for (const chatId of ["zgr-1c7aa981bbcf52910bde", "zgr-5f2b2b46331ada44830b"]) {
    for (const text of ["id", "doanh thu", "hello"]) {
      const response = await POST(request(chatId, text));
      assert.equal(response.status, 200);
    }
  }
  assert.equal(sent.length, 0, "pickup group must receive no webhook reply");

  await POST(request("zgr-other", "doanh thu"));
  assert.equal(sent.length, 1, "other unauthorized groups retain the existing response");
  assert.match(sent[0], /không có quyền xem doanh thu/);
  console.log("Zalo webhook silence check passed.");
} finally {
  globalThis.fetch = originalFetch;
}
