import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { diffPayRows, onlyPartTime, payrollDays, summarizeDrivers } from "../src/lib/payroll-reconcile";
import { getJobsByStatusAndDate } from "../src/lib/cartrack";
import { attachPayDistances, buildDayPay } from "../src/lib/pay";
import type { TimelineRoute } from "../src/lib/types";
import { generateKeyPairSync } from "node:crypto";
import { encryptAudit, decryptAudit } from "./payroll-audit-crypto";
import { payrollArchiveSucceeded } from "../src/lib/tat-archive";
import type { PayJob, PayPunch } from "../src/lib/pay";

const job = (id: number, date = "2026-08-15", km: number | null = 3.9): PayJob => ({
  trip_date: date, driver_id: "tuan", driver_name: "P - P - PT100001 Nguyễn Văn A", job_id: id,
  reference_number: `job-${id}`, pickup_customer_id: "D018", pickup_name: "BRA - D018",
  pickup_lat: 10.779712, pickup_lng: 106.70079, pickup_completed_ts: `${date}T18:55:00+07:00`,
  dropoff_customer_id: "D001", dropoff_name: "BRA - D001", dropoff_lat: 10.775086,
  dropoff_lng: 106.672714, dropoff_completed_ts: `${date}T19:15:00+07:00`, distance_km: km,
});

const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const encrypted = encryptAudit("restricted payroll snapshot", keys.publicKey);
assert.equal(decryptAudit(encrypted, keys.privateKey), "restricted payroll snapshot");
const modified = Buffer.from(encrypted.ciphertext, "base64");
modified[0] ^= 1;
assert.throws(() => decryptAudit({ ...encrypted, ciphertext: modified.toString("base64") }, keys.privateKey));

assert.equal(payrollDays("2026-08-15", "2026-09-14").length, 31);
assert.equal(payrollDays("2026-08-15", "2026-09-14")[0], "2026-08-15");
assert.equal(payrollDays("2026-08-15", "2026-09-14").at(-1), "2026-09-14");

const tuan = Array.from({ length: 12 }, (_, i) => job(i + 1));
assert.equal(summarizeDrivers(tuan, [])[0].km, 46.8);
assert.equal(summarizeDrivers(tuan, [])[0].jobs, 12);
assert.equal(summarizeDrivers(tuan, [])[0].km_pay, 93600);
assert.equal(onlyPartTime([job(1), { ...job(2), driver_name: "P - DC100001 Nguyễn Văn A" }]).length, 1);

const diff = diffPayRows(tuan, [job(1), job(2, "2026-08-16")]);
assert.equal(diff.missing.length, 11);
assert.equal(diff.stale.length, 1);
assert.deepEqual(diff.wrong_date, [{ job_id: 2, expected: "2026-08-15", stored: "2026-08-16" }]);
assert.equal(diffPayRows([job(1), job(1)], []).duplicates.length, 1);
assert.equal(diffPayRows([job(1)], [{ ...job(1), distance_km: 48 }]).changed.length, 1);
assert.equal(diffPayRows([job(1)], [{ ...job(1), pickup_completed_ts: "2026-08-15T11:55:00Z" }]).changed.length, 0);
assert.equal(diffPayRows([job(1)], [{ ...job(1), driver_id: "full-time-account" }]).wrong_driver.length, 1);
const withoutCoords = { ...job(50, "2026-08-15", null), pickup_lat: null };
assert.equal((await attachPayDistances([withoutCoords])).noCoords, 1);
assert.equal(withoutCoords.distance_km, null);
const existingRoute = { routeId: "driver_tuan", driverFullname: "P - PT100001 Nguyễn Văn A", orderedStops: [
  { jobId: 1, stopId: 1, stopTypeId: 1, jobStatusId: 5, latitude: null, longitude: null, activityCompletedTs: "2026-08-15 09:00:00" },
  { jobId: 1, stopId: 2, stopTypeId: 2, jobStatusId: 5, latitude: null, longitude: null, activityCompletedTs: "2026-08-15 10:00:00" },
] } as unknown as TimelineRoute;
assert.equal((await buildDayPay([existingRoute], "2026-08-15", [job(1)])).jobs[0].distance_km, 3.9);

const punches: PayPunch[] = [
  { trip_date: "2026-08-15", driver_id: "tuan", driver_name: "P - P - PT100001 Nguyễn Văn A", job_id: 21, kind: "in", customer_id: "D018", location_name: "D018", started_ts: null, arrived_ts: null, completed_ts: "2026-08-15T18:00:00+07:00", job_status_id: 5 },
  { trip_date: "2026-08-15", driver_id: "tuan", driver_name: "P - P - PT100001 Nguyễn Văn A", job_id: 22, kind: "out", customer_id: "D001", location_name: "D001", started_ts: null, arrived_ts: null, completed_ts: "2026-08-15T19:00:00+07:00", job_status_id: 5 },
];
assert.equal(summarizeDrivers([], punches)[0].worked_mins, 60);
assert.equal(payrollArchiveSucceeded({ error: "write failed" }), false);
assert.equal(payrollArchiveSucceeded({ jobs: 1 }), true);

// PostgREST pagination: 1,001 rows must require two pages and retain them all.
const offsets: number[] = [];
const server = createServer((req, res) => {
  const url = new URL(req.url!, "http://127.0.0.1");
  const offset = Number(url.searchParams.get("offset") ?? 0);
  offsets.push(offset);
  const count = offset === 0 ? 1000 : offset === 1000 ? 1 : 0;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(Array.from({ length: count }, (_, i) => ({ id: offset + i }))));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server did not bind");
process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
const { sbSelectAll } = await import("../src/lib/supabase-rest");
const rows = await sbSelectAll<{ id: number }>("rows", "select=*&order=id.asc");
assert.equal(rows.length, 1001);
assert.deepEqual(offsets, [0, 1000]);
await assert.rejects(() => sbSelectAll("rows", "select=*"), /stable order/);
server.close();

// Strict Cartrack collection must exhaust pages and reject a replay or bad shape.
process.env.CARTRACK_AUTH = "Basic test-only";
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (input) => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    return Response.json({ data: Array.from({ length: page <= 6 ? 1000 : 1 }, (_, i) => ({ job_id: (page - 1) * 1000 + i })) });
  };
  assert.equal((await getJobsByStatusAndDate(5, "2026-08-15", "prod", { strictPagination: true })).length, 6001);
  globalThis.fetch = async () => Response.json({ data: Array.from({ length: 1000 }, (_, i) => ({ job_id: i })) });
  await assert.rejects(() => getJobsByStatusAndDate(5, "2026-08-15", "prod", { strictPagination: true }), /repeated a full page/);
  globalThis.fetch = async () => Response.json({ error: "unexpected" });
  await assert.rejects(() => getJobsByStatusAndDate(5, "2026-08-15", "prod", { strictPagination: true }), /unfamiliar/);
  // A failed provider is recorded as unpriced; it cannot erase a prior distance.
  process.env.GOONG_API_KEY = "test-only";
  globalThis.fetch = async () => new Response("provider unavailable", { status: 503 });
  const unpriced = job(99, "2026-08-15", null);
  assert.equal((await attachPayDistances([unpriced])).failed, 1);
  assert.equal(unpriced.distance_km, null);
} finally { globalThis.fetch = originalFetch; }

console.log("Payroll reconciliation: boundaries, Tuấn regression, diffs, attendance, retry contract and pagination passed.");
