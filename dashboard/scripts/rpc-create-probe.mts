/**
 * Does delivery_create_job still answer in the shape createJob expects?
 *
 * createJob treats "RPC returned no result.data.job_id" as failure and falls back to a REST
 * POST. That fallback is NOT idempotent: if the RPC actually created the job, the POST
 * creates a second one — same payload, same reference, seconds apart. Which is the exact
 * signature of this morning's duplicates, and Cartrack shipped a new version this morning.
 *
 * This calls the RPC directly and prints the RAW response, so the shape can be compared
 * against what createJob reads. It then reports every job matching the reference so a
 * double-create is visible immediately.
 *
 *   cd dashboard && npx tsx scripts/rpc-create-probe.mts
 *
 * Creates ONE real D030 job and deletes it again.
 */

import { readFileSync } from "node:fs";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const { jsonRpc, deleteJob, BASE_URL, getHeaders } = await import("../src/lib/cartrack");
const { vnDate, vnHoursMinutes } = await import("../src/lib/time");

const PICKUP = "c450f244-3b21-11f1-9378-fa163ee8d8ac";  // BRA - D030
const DROPOFF = "b959ed68-446d-11ed-b04f-506b8dbc8dfb"; // 3PL - D030 - THB
const { hours, minutes } = vnHoursMinutes();
const ref = `PROBE-D030_${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;

// The same shape restJobToRpc produces for a psc-assign payload.
const data = {
  jobTypeId: 1,
  scheduleType: "scheduled",
  referenceNumber: ref,
  // Two minutes ahead, in VN local time, formatted exactly Y-m-d\TH:i:sP. Cartrack rejects
  // both a past timestamp and any millisecond component.
  scheduledDeliveryTs: new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(Date.now() + 120_000)).replace(" ", "T") + "+07:00",
  stops: [
    { stopTypeId: 1, customerId: PICKUP, duration: 5 },
    { stopTypeId: 2, customerId: DROPOFF, duration: 10 },
  ],
};

console.log(`\nProbing delivery_create_job with reference ${ref}\n`);
const out = await jsonRpc<Record<string, unknown>>("delivery_create_job", { data });

console.log("ok:      ", out.ok);
if (!out.ok) console.log("error:   ", out.error);
console.log("raw result:");
console.log(JSON.stringify(out.ok ? out.result : null, null, 2).slice(0, 1200));

// What createJob actually reads:
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readsJobId = (out.ok ? (out.result as any)?.data?.job_id : undefined);
console.log(`\ncreateJob reads result.data.job_id  ->  ${readsJobId ?? "UNDEFINED"}`);
console.log(readsJobId
  ? "  shape intact: createJob would accept this and NOT fall back to REST."
  : "  SHAPE CHANGED: createJob would call this a failure and POST the job again -> DUPLICATE.");

// Did a job actually get created, whatever the response looked like?
const res = await fetch(
  `${BASE_URL}/jobs?filter[scheduled_delivery_ts_from]=${vnDate()} 00:00:00&filter[scheduled_delivery_ts_to]=${vnDate()} 23:59:59&limit=1000`,
  { headers: getHeaders("prod"), cache: "no-store" },
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const all: any[] = (await res.json().catch(() => ({})))?.data ?? [];
const mine = all.filter((j) => j.reference_number === ref);
console.log(`\njobs actually created with this reference: ${mine.length} -> ${mine.map((j) => j.job_id).join(", ") || "(none)"}`);
if (mine.length && !readsJobId) {
  console.log("  >>> The RPC CREATED the job but reported a shape createJob calls failure.");
  console.log("  >>> That is the duplicate: the REST fallback would now create a second one.");
}

for (const j of mine) {
  const ok = await deleteJob(j.job_id, "prod");
  console.log(`cleanup: deleted ${j.job_id} -> ${ok}`);
}
