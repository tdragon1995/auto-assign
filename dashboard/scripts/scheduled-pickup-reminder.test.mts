import assert from "node:assert/strict";
import type { Job } from "../src/lib/types";

process.env.TZ = "UTC"; // Vercel parses timezone-less dates in UTC.
process.env.CARTRACK_AUTH = "Basic mocked";
process.env.CARTRACK_AUTH_UAT = "Basic mocked";
process.env.CARTRACK_WEB_PASS = ""; // unassignJob falls back to a mocked REST PUT
process.env.CARTRACK_WEB_PASS_UAT = "";
process.env.KV_REST_API_URL = "https://redis.test";
process.env.KV_REST_API_TOKEN = "mocked";
process.env.ZALO_KIOT_BOT_TOKEN = "pharmacy-token";
process.env.ZALO_ADMIN_BOT_TOKEN = "admin-token";

const { PROXY_DRIVER_ID } = await import("../src/lib/cartrack");
const { releaseDueProxyJobs, remindDueUnassignedScheduledPickups } = await import("../src/lib/assign");
const { getDueTomorrowJobs } = await import("../src/lib/scheduled-dispatch");
const labels = ["📅 Lịch cố định"];
const customer = "51bfb168-446f-11ed-888f-506b8dbc8dfb";
const chat = "zgr-1c7aa981bbcf52910bde";
const message = "Dạ, sắp đến giờ lấy mẫu cố định của bên mình rồi ạ. Bên mình hôm nay có mẫu không, cho Diag xin xác nhận với ạ?\n👉 Tag **@Bot Điều Phối X** để báo không có mẫu";
const now = new Date("2026-09-29T23:35:00+07:00");

function job(id: number, change: Partial<Job> = {}): Job {
  return {
    job_id: id,
    job_status_id: 4,
    delivery_driver_id: PROXY_DRIVER_ID,
    send_to_driver_at: "2020-09-29 23:10:00",
    labels,
    stops: [
      { stop_type_id: 1, stop_status_id: 1, customer_id: customer, delivery_windows: [{ time_from: "00:10:00+07:00" }] },
      { stop_type_id: 2, customer_id: "dropoff" },
    ],
    ...change,
  };
}

const otherCustomer = job(102, { stops: [{ ...job(102).stops[0], customer_id: "other" }] });
const oneOff = job(103, { labels: [] });
const started = job(104, { stops: [{ ...job(104).stops[0], activity_started_ts: "2026-09-29 22:00:00" }] });
const failed = job(105);
const tomorrowFailed = job(202);
const sends: { url: string; body: { chat_id: string; text: string; parse_mode?: string } }[] = [];
const claims = new Set<string>();
const events: string[] = [];
const logs: string[] = [];
let tomorrowJobs: Job[] = [];
let failSend = false;
let failStorage = false;
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://redis.test")) {
    if (failStorage) throw new Error("Redis unavailable");
    const commands = JSON.parse(String(init?.body)) as (string | number)[][];
    if (commands[0]?.[0] === "set") {
      const key = String(commands[0][1]);
      assert.match(key, /^assign:late_alert:prod:\d+:fixed-pickup-reminder$/);
      const result = claims.has(key) ? null : "OK";
      claims.add(key);
      return Response.json([{ result }]);
    }
    if (commands[0]?.[0] === "mget") return Response.json([{ result: [null, null] }]);
    throw new Error(`Unexpected Redis command: ${commands[0]?.[0]}`);
  }
  if (url.includes("/drivers/") && url.includes("/jobs?")) return Response.json({ data: [] });
  if (url.includes("/jobs?") && init?.method !== "PUT") return Response.json({ data: tomorrowJobs });
  if (url.includes("/jobs/assign/preassigned-driver") && init?.method === "PUT") {
    events.push("preassign:301");
    return Response.json({ data: { job_id: 301, delivery_driver_id: "preassigned-driver" } });
  }
  if (url.includes("/jobs/") && init?.method === "PUT") {
    const id = Number(url.match(/\/jobs\/(\d+)/)?.[1]);
    events.push(`release:${id}`);
    return new Response(null, { status: [failed.job_id, tomorrowFailed.job_id].includes(id) ? 500 : 200 });
  }
  if (url.startsWith("https://docs.google.com/spreadsheets/")) {
    return new Response("pickup_id,dropoff_id,delivery_windows,reference,driver_id,Driver\n" +
      `${customer},dropoff,00:10,scheduled-301,preassigned-driver,Pharmacy Driver\n`);
  }
  if (url.startsWith("https://bot-api.zaloplatforms.com/")) {
    const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string; parse_mode?: string };
    sends.push({ url, body });
    events.push(`send:${body.chat_id}`);
    return new Response(null, { status: failSend ? 500 : 200 });
  }
  throw new Error(`Unexpected mocked request: ${url}`);
};

const log = (text: string) => { logs.push(text); };
try {
  const normal = await releaseDueProxyJobs("2026-09-29", "prod", log, [job(101), otherCustomer, oneOff, started, failed]);
  assert.deepEqual(normal.releasedIds.sort(), [101, 102, 103, 104]);
  assert.equal(sends.length, 1, JSON.stringify({ logs, events }));
  assert.deepEqual(sends[0], { url: "https://bot-api.zaloplatforms.com/botpharmacy-token/sendMessage", body: { chat_id: chat, text: message, parse_mode: "markdown" } });
  assert.ok(events.indexOf("release:101") < events.indexOf(`send:${chat}`));

  await releaseDueProxyJobs("2026-09-29", "prod", log, [job(101)]);
  assert.equal(sends.length, 1, "stale queue list must not repeat a reminder");
  await releaseDueProxyJobs("2026-09-29", "uat", log, [job(106)]);
  assert.equal(sends.length, 1, "UAT must not send");

  tomorrowJobs = [job(201, { send_to_driver_at: "2026-09-29 23:10:00" }), job(202, { send_to_driver_at: "2026-09-29 23:10:00" }), job(203, { job_status_id: 2, delivery_driver_id: null })];
  const due = await getDueTomorrowJobs("prod", log, now);
  assert.deepEqual(due.map((j) => j.job_id), [201, 203]);
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[1], sends[0]);
  await releaseDueProxyJobs("2026-09-29", "prod", log, [job(201)]);
  assert.equal(sends.length, 2, "both release paths must share the same claim");

  failSend = true;
  const sendFailure = await releaseDueProxyJobs("2026-09-29", "prod", log, [job(107)]);
  assert.deepEqual(sendFailure.releasedIds, [107], "Zalo failure must not undo a release");
  assert.ok(logs.some((line) => line.includes("Job 107 - Fixed-pickup Zalo reminder failed")));
  tomorrowJobs = [job(204, { send_to_driver_at: "2026-09-29 23:10:00" })];
  const dueAfterSendFailure = await getDueTomorrowJobs("prod", log, now);
  assert.deepEqual(dueAfterSendFailure.map((j) => j.job_id), [204], "Zalo failure must not hide a released job from assignment");

  failStorage = true;
  const storageFailure = await releaseDueProxyJobs("2026-09-29", "prod", log, [job(108)]);
  assert.deepEqual(storageFailure.releasedIds, [108], "Redis failure must not undo a release");
  assert.equal(sends.length, 6, "do not send without a deduplication claim");
  assert.ok(logs.some((line) => line.includes("Job 108 - Fixed-pickup Zalo reminder failed")));

  failStorage = false;
  delete process.env.ZALO_KIOT_BOT_TOKEN;
  delete process.env.ZALO_ADMIN_BOT_TOKEN;
  const noBot = await releaseDueProxyJobs("2026-09-29", "prod", log, [job(109)]);
  assert.deepEqual(noBot.releasedIds, [109]);
  assert.equal(sends.length, 6);
  assert.ok(logs.some((line) => line.includes("Job 109 - Fixed-pickup Zalo reminder skipped: bot token missing")));

  process.env.ZALO_KIOT_BOT_TOKEN = "pharmacy-token";
  const preassigned = await releaseDueProxyJobs("2026-09-29", "prod", log, [job(301, { reference_number: "scheduled-301_2026-09-29" })]);
  assert.deepEqual(preassigned.releasedIds, [], "direct preassignment never enters the unassigned pool");
  assert.ok(events.includes("preassign:301"));
  assert.equal(sends.length, 8, "direct preassignment also sends one reminder");
  assert.ok(events.indexOf("preassign:301") < events.lastIndexOf(`send:${chat}`));

  failSend = false;
  const secondCustomer = job(401, { stops: [{ ...job(401).stops[0], customer_id: "f88dfab6-b522-11ee-bb52-506b8d9879b5" }] });
  const secondRelease = await releaseDueProxyJobs("2026-09-29", "prod", log, [secondCustomer]);
  assert.deepEqual(secondRelease.releasedIds, [401]);
  assert.deepEqual(sends.at(-1)?.body, { chat_id: "zgr-5f2b2b46331ada44830b", text: message, parse_mode: "markdown" });

  // Cartrack sometimes unassigns a parked job before the proxy scan sees it.
  const unassigned = job(501, { job_status_id: 2, delivery_driver_id: null, send_to_driver_at: "2026-09-29 23:10:00" });
  const beforeFallback = sends.length;
  await remindDueUnassignedScheduledPickups([
    unassigned,
    job(502, { job_status_id: 2, delivery_driver_id: null, send_to_driver_at: "2030-09-29 23:10:00" }),
    job(503, { job_status_id: 2, delivery_driver_id: null, labels: [] }),
    job(504, { job_status_id: 2, delivery_driver_id: null, stops: [{ ...job(504).stops[0], activity_started_ts: "2026-09-29 22:00:00" }] }),
    job(505),
  ], "prod", log, now.getTime());
  assert.equal(sends.length, beforeFallback + 1);
  assert.deepEqual(sends.at(-1), { url: "https://bot-api.zaloplatforms.com/botpharmacy-token/sendMessage", body: { chat_id: chat, text: message, parse_mode: "markdown" } });
  await releaseDueProxyJobs("2026-09-29", "prod", log, [job(501)]);
  await remindDueUnassignedScheduledPickups([unassigned], "uat", log, now.getTime());
  assert.equal(sends.length, beforeFallback + 1, "fallback and release share one claim; UAT stays silent");

  failSend = true;
  await remindDueUnassignedScheduledPickups([job(506, { job_status_id: 2, delivery_driver_id: null })], "prod", log, now.getTime());
  assert.ok(logs.some((line) => line.includes("Job 506 - Fixed-pickup Zalo reminder failed")));

  // Both bots use the same wording and bold their own display name.
  failSend = false;
  process.env.ZALO_SAMPLE_BOT_TOKEN = "sample-token";
  process.env.ZALO_SAMPLE_CHAT_ID = "sample-group";
  const { remindScheduledPickup, SAMPLE_PICKUP_CUSTOMER_ID } = await import("../src/lib/scheduled-pickup-reminder");
  await remindScheduledPickup(job(601, { stops: [{ ...job(601).stops[0], customer_id: SAMPLE_PICKUP_CUSTOMER_ID }] }), "prod", log);
  assert.deepEqual(sends.at(-1), {
    url: "https://bot-api.zaloplatforms.com/botsample-token/sendMessage",
    body: { chat_id: "sample-group", text: message.replace("@Bot Điều Phối X", "@Bot Giao nhận mẫu"), parse_mode: "markdown" },
  });

  console.log("Scheduled pickup reminder checks passed.");
} finally {
  globalThis.fetch = originalFetch;
}
