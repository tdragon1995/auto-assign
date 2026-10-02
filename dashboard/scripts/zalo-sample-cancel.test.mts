import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { cancelableScheduleJobs, isNoSampleCommand, POST } from "../src/app/api/zalo/sample-cancel/route";
import { SAMPLE_PICKUP_CUSTOMER_ID } from "../src/lib/scheduled-pickup-reminder";
import type { Job } from "../src/lib/types";

for (const text of ["/không có mẫu", "/k co mau", "/k có mẫu", "@Bot Giao nhận mẫu /không có mẫu", "/k co mau @Bot Giao nhận mẫu"]) {
  assert.equal(isNoSampleCommand(text), true, text);
}
for (const text of ["/có mẫu", "không có mẫu", "/không có mẫu nữa"]) {
  assert.equal(isNoSampleCommand(text), false, text);
}

const today = "2026-10-01";
const job = (overrides: Partial<Job> = {}): Job => ({
  job_id: 1,
  job_status_id: 4,
  scheduled_delivery_ts: today + " 10:30:00",
  labels: ["📅 Lịch cố định"],
  stops: [{ stop_type_id: 1, stop_status_id: 1, customer_id: SAMPLE_PICKUP_CUSTOMER_ID }],
  ...overrides,
});
assert.deepEqual(cancelableScheduleJobs([job()], today).map((j) => j.job_id), [1]);
assert.equal(cancelableScheduleJobs([job({ labels: [] })], today).length, 0);
assert.equal(cancelableScheduleJobs([job({ scheduled_delivery_ts: "2026-10-02 10:30:00" })], today).length, 0);
assert.equal(cancelableScheduleJobs([job({ stops: [{ stop_type_id: 1, stop_status_id: 2, customer_id: SAMPLE_PICKUP_CUSTOMER_ID }] })], today).length, 0);
assert.equal(cancelableScheduleJobs([job({ stops: [{ stop_type_id: 1, stop_status_id: 1, customer_id: "other" }] })], today).length, 0);

// A real handler request: Zalo's documented envelope and tagged commands must reply.
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const sends: { chat_id: string; text: string }[] = [];
try {
  process.env.ZALO_SAMPLE_BOT_TOKEN = "test-token";
  process.env.ZALO_SAMPLE_WEBHOOK_SECRET = "test-secret";
  delete process.env.ZALO_SAMPLE_CHAT_ID;
  globalThis.fetch = async (_url, init) => {
    sends.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  };
  const message = (text: string, chatType = "GROUP") => ({
    event_name: "message.text.received",
    message: { text, chat: { id: "test-group", chat_type: chatType }, from: { is_bot: false } },
  });
  const request = (body: unknown, secret = "test-secret") => new NextRequest("https://example.test/api/zalo/sample-cancel", {
    method: "POST", headers: { "Content-Type": "application/json", "x-bot-api-secret-token": secret },
    body: JSON.stringify(body),
  });
  for (const text of ["/id", "@Bot Giao nhận mẫu /id", "/id @Bot Giao nhận mẫu"]) {
    const response = await POST(request({ ok: true, result: message(text) }));
    assert.equal(response.status, 200);
  }
  await POST(request(message("/id")));
  assert.equal(sends.length, 4);
  assert.ok(sends.every((reply) => reply.chat_id === "test-group" && reply.text === "Chat ID: test-group"));
  assert.equal((await POST(request(message("/id"), "wrong-secret"))).status, 401);
  await POST(request({ ok: true, result: message("/id", "PRIVATE") }));
  await POST(request({ ok: true, result: message("/k co mau") }));
  await POST(request(null));
  assert.equal(sends.length, 4, "Unauthorized/private/cancellation messages must not act during setup");
} finally {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
}
