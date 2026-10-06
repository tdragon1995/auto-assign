import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { classifyPickupReply, cancelableScheduleJobs } from "../src/lib/scheduled-pickup-cancel";
import { CHAT_BY_CUSTOMER_ID, PHARMACY_PICKUP_CUSTOMER_ID, SAMPLE_PICKUP_CUSTOMER_ID } from "../src/lib/scheduled-pickup-reminder";
import { vnDate } from "../src/lib/time";
import { PROXY_DRIVER_ID } from "../src/lib/cartrack";
import type { Job } from "../src/lib/types";

process.env.ZALO_KIOT_WEBHOOK_SECRET = "mock-secret";
process.env.ZALO_KIOT_BOT_TOKEN = "mock-bot";
process.env.ZALO_KIOT_ALLOWED_CHATS = "zgr-authorized";
process.env.CARTRACK_AUTH = "mock-auth";

const { POST } = await import("../src/app/api/zalo/webhook/route");
const originalFetch = globalThis.fetch;
const sent: string[] = [];
let jobReads = 0;
let lookupJobs: Job[] = [];
globalThis.fetch = async (input, init) => {
  if (String(input).startsWith("https://fleetapi-vn.cartrack.com/rest/delivery/jobs?")) {
    jobReads++;
    return Response.json({ data: lookupJobs });
  }
  sent.push(String(init?.body));
  return Response.json({ ok: true });
};

const request = (chatId: string, text: string) => new NextRequest(
  "https://example.test/api/zalo/webhook?key=mock-secret",
  { method: "POST", body: JSON.stringify({ event_name: "message.text.received", message: { chat: { id: chatId, chat_type: "GROUP" }, from: { is_bot: false }, text } }) },
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

  const pharmacyChat = CHAT_BY_CUSTOMER_ID[PHARMACY_PICKUP_CUSTOMER_ID];
  const webhookRequest = (text: string, overrides: Record<string, unknown> = {}, secret = "mock-secret") => new NextRequest(
    "https://example.test/api/zalo/webhook", {
      method: "POST", headers: { "x-bot-api-secret-token": secret },
      body: JSON.stringify({ ok: true, result: { event_name: "message.text.received", message: {
        text, chat: { id: pharmacyChat, chat_type: "GROUP" }, from: { is_bot: false }, ...overrides,
      } } }),
    },
  );
  const positives = ["dạ có mẫu ạ", "@Bot Điều Phối X dạ có mẫu a", "có mẫu nhe", "có mẫu", "hôm nay có mẫu", "đã có mẫu", "có mẫu rồi"];
  for (const text of positives) {
    assert.equal(classifyPickupReply(text), "ignore", text);
    for (const chatId of Object.values(CHAT_BY_CUSTOMER_ID)) {
      await POST(webhookRequest(text, { chat: { id: chatId, chat_type: "GROUP" } }));
    }
  }
  assert.equal(jobReads, 0, "positive/ambiguous replies must never enter cancellation");
  assert.equal(sent.length, 1, "positive replies in the pickup group stay silent");
  const negatives = ["ko mẫu", "không mẫu", "k mẫu", "ko mẫu nha", "chưa có mẫu nhé", "dạ hôm nay không có mẫu ạ", "@Bot Điều Phối X dạ ko mẫu a", "dạ ko mẫu a", "chưa có mẫu", "không có mẫu", "k có mẫu", "chua co mau", "hôm nay chưa có mẫu", "hôm nay k có mẫu", "ko có", "chưa có", "k có", "@Bot Điều Phối X ko có"];
  for (const chatId of Object.values(CHAT_BY_CUSTOMER_ID)) {
    const before = sent.length;
    for (const text of negatives) {
      assert.equal(classifyPickupReply(text), "cancel", text);
      await POST(webhookRequest(text, { chat: { id: chatId, chat_type: "GROUP" } }));
    }
    assert.ok(sent.slice(before).every((body) => JSON.parse(body).chat_id === chatId));
  }
  const expectedReads = negatives.length * Object.keys(CHAT_BY_CUSTOMER_ID).length;
  assert.equal(jobReads, expectedReads, "all configured pickup groups must handle negative replies");
  assert.equal(sent.length, 1 + expectedReads);
  const reviewStart = sent.length;
  for (const chatId of Object.values(CHAT_BY_CUSTOMER_ID)) {
    for (const text of ["không có mẫu nhưng chiều có mẫu", "mai không có mẫu", "chưa có mẫu?", "chưa có mẫu nhưng lát có mẫu"]) {
      assert.equal(classifyPickupReply(text), "review", text);
      await POST(webhookRequest(text, { chat: { id: chatId, chat_type: "GROUP" } }));
    }
    for (const text of ["lát nữa", "để em báo lại", "cho em xác nhận"]) {
      assert.equal(classifyPickupReply(text), "ignore", text);
      await POST(webhookRequest(text, { chat: { id: chatId, chat_type: "GROUP" } }));
    }
  }
  assert.equal(jobReads, expectedReads, "review and ignored replies must never enter the cancellation path");
  assert.ok(sent.slice(reviewStart).every(body => JSON.parse(body).text.includes("Bot chưa huỷ")));
  await POST(webhookRequest("chưa có mẫu", { from: { is_bot: true } }));
  await POST(webhookRequest("chưa có mẫu", { chat: { id: pharmacyChat, chat_type: "PRIVATE" } }));
  await POST(webhookRequest("chưa có mẫu", { chat: { id: "zgr-unmapped", chat_type: "GROUP" } }));
  assert.equal((await POST(webhookRequest("chưa có mẫu", {}, "wrong-secret"))).status, 401);
  assert.equal(jobReads, expectedReads, "bots, unmapped groups, private chats and invalid secrets cannot cancel");
  assert.equal(classifyPickupReply("chưa có mẫu"), "cancel", "all clients share the negative phrases");
  const today = "2026-10-05";
  const pickupJob: Job = {
    job_id: 1, job_status_id: 4, scheduled_delivery_ts: today + " 10:30:00", labels: ["📅 Lịch cố định"],
    stops: [{ stop_type_id: 1, stop_status_id: 1, customer_id: PHARMACY_PICKUP_CUSTOMER_ID }],
  };
  assert.equal(cancelableScheduleJobs([pickupJob], today, PHARMACY_PICKUP_CUSTOMER_ID).length, 1);
  assert.equal(cancelableScheduleJobs([pickupJob], today, SAMPLE_PICKUP_CUSTOMER_ID).length, 0);
  assert.equal(cancelableScheduleJobs([{ ...pickupJob, labels: [] }], today, PHARMACY_PICKUP_CUSTOMER_ID).length, 0);
  assert.equal(cancelableScheduleJobs([{ ...pickupJob, scheduled_delivery_ts: "2026-10-06 10:30:00" }], today, PHARMACY_PICKUP_CUSTOMER_ID).length, 0);
  assert.equal(cancelableScheduleJobs([{ ...pickupJob, stops: [{ ...pickupJob.stops![0], activity_started_ts: today + " 09:30:00" }] }], today, PHARMACY_PICKUP_CUSTOMER_ID).length, 0);
  const dueJob = { ...pickupJob, send_to_driver_at: "2026-01-01 08:30:00+07", delivery_driver_id: "real-driver" };
  const futureJob = { ...pickupJob, job_id: 2, send_to_driver_at: "2099-01-01 14:00:00", delivery_driver_id: PROXY_DRIVER_ID };
  assert.deepEqual(cancelableScheduleJobs([dueJob, futureJob], today, PHARMACY_PICKUP_CUSTOMER_ID, true).map((j) => j.job_id), [1], "only the released current pickup is eligible");
  assert.equal(cancelableScheduleJobs([{ ...futureJob, delivery_driver_id: null }], today, PHARMACY_PICKUP_CUSTOMER_ID, true).length, 0, "a failed parking operation cannot expose a future pickup");
  assert.equal(cancelableScheduleJobs([{ ...dueJob, send_to_driver_at: "invalid" }], today, PHARMACY_PICKUP_CUSTOMER_ID, true).length, 0);
  assert.equal(cancelableScheduleJobs([{ ...dueJob, delivery_driver_id: PROXY_DRIVER_ID }], today, PHARMACY_PICKUP_CUSTOMER_ID, true).length, 0, "a pickup still parked must not be cancelled");
  assert.equal(cancelableScheduleJobs([pickupJob], today, PHARMACY_PICKUP_CUSTOMER_ID, true).length, 0, "unknown release state must fail closed");
  lookupJobs = [{ ...dueJob, scheduled_delivery_ts: vnDate() + " 10:30:00" }];
  const otherCustomerChat = Object.entries(CHAT_BY_CUSTOMER_ID).find(([customerId]) => customerId !== PHARMACY_PICKUP_CUSTOMER_ID)![1];
  await POST(webhookRequest("ko có", { chat: { id: otherCustomerChat, chat_type: "GROUP" } }));
  assert.equal(JSON.parse(sent.at(-1)!).text, "Hiện không có chuyến lấy mẫu cố định nào đủ điều kiện huỷ.", "a group cannot cancel another customer's current pickup");
  console.log("Zalo pickup cancellation and revenue isolation check passed.");
} finally {
  globalThis.fetch = originalFetch;
}
