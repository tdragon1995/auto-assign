// Run: npx tsx scripts/batch-lookup.test.mts
import assert from "node:assert/strict";
import { lookupBatch, batchTimestamp, lookupTimestamp, buildLookupTimeline } from "../src/lib/batch-lookup";
import { NextRequest } from "next/server";
import { GET } from "../src/app/api/admin/batch-lookup/route";
import { driverArrivalContext, isKeyLookupEvent } from "../src/components/batch-lookup-panel";

const nativeFetch = globalThis.fetch;
const oldEnv = { email: process.env.LABCENTER_RECEPTIONIST_EMAIL, password: process.env.LABCENTER_RECEPTIONIST_PASSWORD, auth: process.env.CARTRACK_AUTH, lookup: process.env.LABCENTER_LOOKUP_TOKEN };
process.env.LABCENTER_RECEPTIONIST_EMAIL = "fixture@example.test";
process.env.LABCENTER_RECEPTIONIST_PASSWORD = "fixture";
process.env.CARTRACK_AUTH = "Basic fixture";
delete process.env.LABCENTER_LOOKUP_TOKEN;
let mode = "split";
const requests: URL[] = [];
const wrong = "B017260207070500", first = "B017260207071000", second = "B017260207071500";
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const stop = (type: number, name: string, at: string) => ({ stop_type_id: type, customer_name: name, activity_started_ts: at, activity_arrived_ts: at, activity_completed_ts: at });
const job = (id: number, day: string, from: string, to: string, code?: string, driver = "driver1") => ({
  job_id: id, create_ts: `${day} 14:00:00`, update_ts: `${day} 15:00:00`, assigned_ts: `${day} 14:05:00`,
  reference_number: `${from} → ${to}`, delivery_driver_id: driver, job_status_id: 5,
  driver: { first_name: driver, last_name: "Fixture" }, items: code ? [{ tracking_number: code }] : [],
  stops: [stop(1, from, `${day} 14:20:00`), stop(2, to, `${day} 15:00:00`)],
});
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input)); requests.push(url);
  if (url.pathname.endsWith("/auth/login")) return reply({ token: `fixture.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString("base64url")}.fixture` });
  if (url.pathname.endsWith("/orders")) {
    if (mode === "token") assert.equal(new Headers(init?.headers).get("authorization"), "Bearer lookup-only-fixture");
    if (mode === "missing") return reply({}, 404);
    return reply({ data: { lis_order_id: "26020720305", branch_code: "D017", status: "done", created_at: "2026-02-07T06:30:00Z", client_id: "12345",
      patient_name: "PRIVATE FIELD MUST NOT BE RETURNED", order_test_details: [1, 2],
      tat: { logistic_detail: { from_location: "D017", to_location: "D001", duration: "60 min" }, tests_tat: [{ tat: "2026-02-08 16:00:00" }] } } });
  }
  if (url.pathname.endsWith("/client")) return reply({ data: [{ code: "12345", client_legal_name: "Fixture Clinic", owner: "Fixture Owner" }] });
  if (url.pathname.endsWith("/order-sample-details")) return reply({ data: mode === "empty" ? [] : [
    { sample_id: 1, sample_name: "Serum", sample_collected_time: "2026-02-07T07:00:00Z", transferred_time: mode === "wide" ? "2026-02-20T07:30:00Z" : "2026-02-07T07:30:00Z", sample_received_time: "2026-02-08T08:30:00Z" },
    { sample_id: "2", sample_collected_time: "2026-02-07T07:00:00Z", transferred_time: "2026-02-07T07:30:00Z", sample_received_time: "2026-02-08T08:30:00Z" },
  ] });
  if (url.pathname.endsWith("/batch")) {
    if (mode === "denied") return reply({}, 403);
    assert.deepEqual(url.searchParams.getAll("source_location[]"), ["017"]);
    assert.equal(url.searchParams.get("created_at_from"), "2026-02-05T17:00:00.000Z");
    const batch = (code: string, minute: string) => ({ batch_code: code, created_at: `2026-02-07T07:${minute}:00Z`, source_location: "017", destination_location: "001", status: "transferred" });
    return reply({ data: url.searchParams.get("page") === "1" ? [batch(wrong, "05")] : [batch(first, "10"), batch(second, "15")], pagination: { last_page: 2 } });
  }
  if (url.pathname.endsWith("/batch/details")) {
    const code = url.searchParams.get("batch_code");
    return reply({ data: { batch_code: code, created_at: code === first ? "2026-02-07T07:10:00Z" : "2026-02-07T07:15:00Z", batch_status: "completed", total_sample: 1,
      completed_at: "2026-02-08T08:00:00Z", samples: [{ sample_id: code === wrong ? 999 : code === first ? "1" : 2, order_id: "26020720305" }] } });
  }
  if (url.pathname.endsWith("/jobs")) {
    const day = url.searchParams.get("filter[create_ts_from]")?.slice(0, 10);
    if (mode === "route") {
      if (day !== "2026-02-07") return reply({ data: [], meta: { last_page: 1 } });
      return reply({ data: [job(20, day, "BRA - D017", "BRA - D001"), job(21, day, "Clinic", "BRA - D017"), job(22, day, "BRA - D0179", "BRA - D001")], meta: { last_page: 1 } });
    }
    if (day === "2026-02-08") return reply({ data: [job(3, day, "BRA - D019", "BRA - D001", first, "driver2")], meta: { last_page: 1 } });
    if (day !== "2026-02-07") return reply({ data: [], meta: { last_page: 1 } });
    return reply({ data: url.searchParams.get("page") === "1" ? [job(1, day, "BRA - D017", "BRA - D019", first)] : [job(2, day, "BRA - D017", "BRA - D019", second), { ...job(4, day, "BRA - D017", "BRA - D017"), reference_number: "Chấm Công - Vào" }, job(7, day, "46512272 - ThAn - 22/12 - BV COLUMBIA ASIA BD", "BRA - D017")], meta: { last_page: 2 } });
  }
  throw new Error(`Unexpected network call: ${url.pathname}`);
};

try {
  if (process.env.BATCH_LOOKUP_ROUTE_CHECK) {
    mode = "route";
    const route = await lookupBatch("26020720305");
    assert.equal(route.error, undefined);
    assert.deepEqual(route.summary?.jobs.map(j => j.job_id), [20], "exclude inbound runs and similar branch codes");
    assert.equal(route.summary?.jobs[0].match, "route+time");
    assert(route.steps.some(s => s.step === "warning" && s.msg.includes("lower confidence")));
    console.log("route fallback passed");
    process.exit(0);
  }
  assert.equal(batchTimestamp(first), Date.parse("2026-02-07T07:10:00Z"));
  assert.equal(batchTimestamp("B017260230071000"), null);
  assert.equal(batchTimestamp("B017260207251000"), null);
  assert.equal(lookupTimestamp("2026-02-07 14:10:00"), lookupTimestamp("2026-02-07T07:10:00Z"));
  assert.equal(lookupTimestamp("garbage"), null);
  const timeline = buildLookupTimeline({ created_at: "2026-02-07T06:30:00Z", tat: { tests_tat: [{ tat: "2026-02-07 14:05:00" }] } }, [
    { sample_id: "1", sample_collected_time: "2026-02-07T07:00:00Z", sample_received_time: "2026-02-07T07:10:00Z" },
    { sample_id: "2", sample_collected_time: "2026-02-07T07:00:00Z" },
  ], [], []);
  assert.deepEqual(timeline.find(e => e.label === "Sample collected")?.samples, ["1", "2"]);
  assert.equal(timeline.at(-1)?.since_prev_min, 10, "TAT deadline must not reset the previous actual event");

  const events: string[] = [];
  const result = await lookupBatch("26020720305", kind => events.push(kind));
  assert.equal(result.error, undefined);
  if (process.env.BATCH_LOOKUP_FIXTURE_FILE) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.BATCH_LOOKUP_FIXTURE_FILE, JSON.stringify(result));
  }
  assert.deepEqual(result.summary?.batches.map(b => b.code), [first, second]);
  assert.deepEqual(result.summary?.unbatched_samples, []);
  assert.deepEqual(result.summary?.jobs.map(j => j.job_id), [1, 2, 3], "must follow the overnight relay to HQ");
  assert.equal(result.driver_days.length, 2);
  assert(result.driver_days[0].jobs.some(j => j.kind === "clock_in"));
  const hospital = result.driver_days[0].jobs.find(j => j.job_id === 7)!;
  assert.equal(hospital.kind, "other", "numeric customer codes do not imply home visits");
  assert.equal(hospital.stops[0].place, "46512272 - ThAn - 22/12 - BV COLUMBIA ASIA BD", "keep the actual Cartrack stop name");
  assert(!JSON.stringify(result).includes("Home collection"));
  assert.equal(result.summary?.client?.name, "Fixture Clinic");
  assert.equal(result.phases.find(p => p.label === "Collected → last sample received")?.minutes, 1530);
  assert.equal(result.timeline.find(e => e.label === "Sample collected")?.time, "2026-02-07 14:00:00");
  assert(!JSON.stringify(result).includes("PRIVATE FIELD"));
  assert(events.includes("doing") && events.includes("step"));
  const keyEvents = result.timeline.filter(isKeyLookupEvent);
  assert(keyEvents.length > 0 && keyEvents.length < result.timeline.length);
  assert(keyEvents.some(event => event.kind === "due"));
  assert(keyEvents.some(event => event.label.startsWith("Sample received")));
  const leg = result.summary!.jobs[0];
  assert.equal(leg.assigned, "2026-02-07 14:05:00");
  assert(result.timeline.filter(e => e.source === "Cartrack").every(e => e.job_id));
  assert(requests.some(u => u.searchParams.has("filter[scheduled_delivery_ts_from]")), "driver context includes earlier-created scheduled jobs");
  const contextJob = { ...leg, driver_id: "driver1", assigned: "2026-02-07 10:00:00", stops: [
    { place: "Target", type: "Pickup", arrived: "2026-02-07 12:00:00", completed: "2026-02-07 12:05:00" },
    { place: "Lab", type: "Delivery", arrived: "2026-02-07 13:00:00" },
  ] };
  const contextRows = [contextJob,
    { ...contextJob, job_id: 9100, assigned: "2026-02-07 09:00:00", stops: [{ place: "Previous", type: "Delivery", completed: "2026-02-07 09:50:00" }] },
    { ...contextJob, job_id: 9101, assigned: "2026-02-07 09:00:00", stops: [{ place: "Other", type: "Pickup", arrived: "2026-02-07 11:00:00", completed: "2026-02-07 11:05:00" }] },
    { ...contextJob, job_id: 9102, assigned: "2026-02-07 10:30:00", stops: [{ place: "Other", type: "Pickup", arrived: "2026-02-07 11:00:00" }] },
    { ...contextJob, job_id: 9103, driver_id: "different", stops: [{ place: "Wrong driver", type: "Pickup", arrived: "2026-02-07 11:00:00" }] },
    { ...contextJob, job_id: 9104, stops: [{ place: "After arrival", type: "Pickup", arrived: "2026-02-07 14:00:00" }] },
  ];
  const context = driverArrivalContext(contextJob, contextRows);
  assert.equal(context.previous?.place, "Previous");
  assert.deepEqual(context.active.map(j => j.job_id), [9101, 9104]);
  assert.deepEqual(context.route.map(s => s.place), ["Other"], "deduplicate shared stop and exclude later activity or another driver");
  assert.deepEqual(driverArrivalContext(contextJob, contextRows, 1).route.map(s => s.place), ["Other", "Target"], "delivery hover uses its own arrival, not the pickup window");
  assert.equal(driverArrivalContext({ ...contextJob, assigned: null }, contextRows).known, false);
  assert.deepEqual(driverArrivalContext({ ...contextJob, assigned: null }, contextRows).active, []);
  assert(!requests.some(u => /gps|track|polyline/.test(u.pathname)), "no map or GPS fetches");
  assert(requests.some(u => u.pathname.endsWith("/jobs") && u.searchParams.get("page") === "2"), "honor pagination even on a short first page");

  const before = requests.filter(u => u.pathname.endsWith("/jobs")).length;
  await lookupBatch("26020720305");
  assert.equal(requests.filter(u => u.pathname.endsWith("/jobs")).length, before, "repeated lookups reuse cached days");
  const invalid = await GET(new NextRequest("http://localhost/api/admin/batch-lookup?vid=abc"));
  assert.equal(invalid.status, 400);
  const response = await GET(new NextRequest("http://localhost/api/admin/batch-lookup?vid=26020720305"));
  assert(response.headers.get("content-type")?.startsWith("text/event-stream"));
  const stream = await response.text();
  assert(stream.includes("event: doing") && stream.includes("event: step") && stream.includes("event: done"));

  mode = "denied";
  const partial = await lookupBatch("26020720305");
  assert(partial.error?.includes("403"));
  assert.equal(partial.summary?.samples.length, 2, "retain retrieved samples when a later endpoint fails");
  assert(partial.timeline.length > 0);
  mode = "missing";
  assert((await lookupBatch("26020720305")).error?.includes("No order found"));
  mode = "empty";
  const empty = await lookupBatch("26020720305");
  assert.equal(empty.error, undefined);
  assert.equal(empty.summary?.samples.length, 0);
  mode = "wide";
  assert((await lookupBatch("26020720305")).error?.includes("seven-day"));
  mode = "token";
  process.env.LABCENTER_LOOKUP_TOKEN = "lookup-only-fixture";
  assert.equal((await lookupBatch("26020720305")).error, undefined);
  delete process.env.LABCENTER_LOOKUP_TOKEN;

  // Reload the module in a child process to give route-only fixtures a fresh day cache.
  if (!process.env.BATCH_LOOKUP_ROUTE_CHECK) {
    const { spawnSync } = await import("node:child_process");
    const child = spawnSync(process.execPath, [...process.execArgv, import.meta.filename], { env: { ...process.env, BATCH_LOOKUP_ROUTE_CHECK: "1" }, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  }
  console.log("batch lookup: timezone, split batches, relay, pagination, cache, SSE, partial failures and input validation passed");
} finally {
  globalThis.fetch = nativeFetch;
  for (const [key, value] of Object.entries({ LABCENTER_RECEPTIONIST_EMAIL: oldEnv.email, LABCENTER_RECEPTIONIST_PASSWORD: oldEnv.password, CARTRACK_AUTH: oldEnv.auth, LABCENTER_LOOKUP_TOKEN: oldEnv.lookup })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
