// Run: npx tsx scripts/window-late.test.mts
import assert from "node:assert/strict";
import type { Job, PickupWarning } from "../src/lib/types";

process.env.KV_REST_API_URL = "https://redis.test";
process.env.KV_REST_API_TOKEN = "mocked";
process.env.ZALO_ADMIN_BOT_TOKEN = "mocked";
process.env.ZALO_ADMIN_CHAT_ID = "supervisors";
const { computePickupWarnings, alertLateJobs } = await import("../src/lib/assign");

const today = "2026-10-03";
const originalDate = Date;
const originalFetch = globalThis.fetch;
let now = new originalDate(`${today}T09:35:00+07:00`).getTime();
// Both Date.now() and new Date() must use the same clock (quiet-hours guard).
globalThis.Date = class extends originalDate {
  constructor(value: string | number = now) { super(value); }
  static now() { return now; }
} as DateConstructor;

const job: Job = {
  job_id: 101, job_status_id: 4, delivery_driver_id: "driver-1",
  scheduled_delivery_ts: `${today} 09:00:00`,
  stops: [
    { stop_id: 1, stop_type_id: 1, stop_status_id: 1, customer_id: "clinic", customer_name: "Clinic",
      delivery_windows: [{ time_from: "09:00:00+07:00", time_to: "09:30:00+07:00" }] },
    { stop_id: 2, stop_type_id: 2, stop_status_id: 1, customer_id: "lab" },
  ],
};
const warnings = (jobs = [job]) => computePickupWarnings(jobs, today);
const claims = new Set<string>();
const messages: string[] = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://redis.test")) {
    const commands = JSON.parse(String(init?.body)) as (string | number)[][];
    assert.equal(commands[0][0], "set");
    assert.ok(commands[0].includes("nx"));
    const key = String(commands[0][1]);
    const result = claims.has(key) ? null : "OK";
    claims.add(key);
    return Response.json([{ result }]);
  }
  assert.ok(url.startsWith("https://bot-api.zaloplatforms.com/"));
  messages.push((JSON.parse(String(init?.body)) as { text: string }).text);
  return new Response(null, { status: 200 });
};

try {
  now -= 1_000;
  assert.deepEqual(warnings(), [], "09:34:59 is inside the grace");
  await alertLateJobs(warnings(), "prod", () => {});
  assert.equal(messages.length, 0);
  now += 1_000;
  const due = warnings();
  assert.equal(due.length, 1, "09:35 is exactly five minutes after the end");
  assert.equal(due[0].minutes_late, 0);
  await alertLateJobs(due, "uat", () => {});
  assert.equal(claims.size, 0, "UAT cannot consume a production claim");
  await alertLateJobs(due, "prod", () => {});
  await alertLateJobs(due, "prod", () => {});
  assert.equal(messages.length, 1, "subsequent cycles do not repeat the alert");
  assert.match(messages[0], /Trễ lấy mẫu ~5 phút/);
  assert.match(messages[0], /khung giờ 09:00–09:30/);

  const other = (completed: boolean): Job => ({
    ...job, job_id: 102, job_status_id: completed ? 5 : 4,
    stops: [{ stop_id: 9, stop_type_id: 1, activity_started_ts: `${today} 09:20:00`,
      ...(completed ? { activity_completed_ts: `${today} 09:25:00` } : {}) }],
  });
  assert.equal(warnings([job, other(false)]).length, 1, "busy driver cannot defer a window deadline");
  assert.equal(warnings([job, other(true)]).length, 1, "recent completion cannot defer a window deadline");
  assert.deepEqual(warnings([{ ...job, stops: [{ ...job.stops[0], activity_started_ts: `${today} 09:32:00` }, job.stops[1]] }]), []);

  const asap: Job = { ...job, stops: [{ ...job.stops[0], delivery_windows: [] }, job.stops[1]] };
  assert.deepEqual(warnings([asap]), [], "ASAP still has a 90-minute dashboard grace");
  const ordinary: PickupWarning = { ...due[0], window_time_from: undefined, window_time_to: undefined, job_id: 103, minutes_late: 29 };
  await alertLateJobs([ordinary], "prod", () => {});
  assert.equal(messages.length, 1, "ASAP still waits 120 minutes to notify");
  await alertLateJobs([{ ...ordinary, minutes_late: 30 }], "prod", () => {});
  assert.equal(messages.length, 2);

  now = new originalDate(`${today}T21:30:00+07:00`).getTime();
  await alertLateJobs([{ ...due[0], job_id: 105 }], "prod", () => {});
  assert.equal(messages.length, 2, "21:30 cutoff remains in effect");
  assert.ok(!claims.has("assign:late_alert:prod:105"));
  console.log("Window late-alert checks passed.");
} finally {
  globalThis.Date = originalDate;
  globalThis.fetch = originalFetch;
}
