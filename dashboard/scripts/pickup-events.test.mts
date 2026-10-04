// Run: npx tsx scripts/pickup-events.test.mts
import assert from "node:assert/strict";
import { pickupEventRows, pickupEtaRows } from "../src/lib/pickup-setup";
import { cartrackHistoryCutoff } from "../src/lib/time";
import { sbUpsert } from "../src/lib/supabase-rest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MasterProfileDetails, type ClientMeta } from "../src/components/master-profile-details";
import type { TimelineRoute, TimelineStop } from "../src/lib/types";

for (const [now, expected] of [
  ["2026-10-04T00:00:00Z", "2026-08-15"],
  ["2026-01-14T00:00:00Z", "2025-11-15"],
  ["2026-02-28T16:59:59Z", "2025-12-15"],
  ["2026-02-28T17:00:00Z", "2026-01-15"],
  ["2028-03-01T00:00:00Z", "2028-01-15"],
]) assert.equal(cartrackHistoryCutoff(new Date(now)), expected);

const date = "2026-09-17";
const stop = (jobId: number, changes: Partial<TimelineStop> = {}) => ({
  jobId, stopId: jobId, stopTypeId: 1, customerId: "client", customerName: "Clinic",
  jobStatusId: 5, scheduledDeliveryTs: `${date} 09:00:00`,
  activityArrivedTs: `${date} 09:40:00`, activityCompletedTs: `${date} 09:45:00`,
  deliveryWindows: [], jobLabels: [], ...changes,
}) as TimelineStop;
const stops = [
  stop(1), stop(2, { lastAssignedPlanId: 9 }), stop(3, { customerName: "BRA - D014" }),
  stop(4, { scheduledDeliveryTs: null }), stop(5, { jobStatusId: 4 }),
  stop(6, { stopTypeId: 2 }), stop(7, { activityCompletedTs: null }),
  stop(8, { activityCompletedTs: "2026-09-18 00:01:00" }),
  stop(9, { referenceNumber: "Chấm Công - Vào" }),
  stop(10, { customerId: "" }), stop(11, { activityArrivedTs: null }),
];
const routes = [{ orderedStops: stops }, { orderedStops: [stops[0]] }] as TimelineRoute[];
const rows = pickupEventRows(routes, date);
assert.deepEqual(rows.map(row => row.job_id), [1, 2, 3, 4, 5, 11]);
assert.equal(rows.length, 6); // repeated route, plan, internal and split-driver pickup
assert.equal(rows[3].scheduled_ts, null);
assert.equal(rows[5].arrived_basis, "completed");
assert.deepEqual(rows.filter(row => row.is_eta_sample).map(row => row.job_id), [1, 11]);
assert.deepEqual(pickupEtaRows(routes).filter(row => row.job_id !== 8).map(row => row.job_id), [1, 7, 11]);
assert.deepEqual(pickupEventRows(routes, "2026-09-18").map(row => row.job_id), [8]);
await assert.rejects(sbUpsert("pay_jobs", [{ trip_date: "2000-01-01" }], "trip_date,job_id"), /outside retained history/);
await assert.rejects(sbUpsert("photo_reviews", [{ review_date: "2000-01-01" }], "job_id"), /outside retained history/);
const profile = (total: number) => renderToStaticMarkup(createElement(MasterProfileDetails, {
  client: {
    customer_id: "client", cartrack: {},
    pickup_volume: { pickup_customer_id: "client", total_pickups: total, average_per_day: total / 50,
      period_from: "2026-08-15", period_to: "2026-10-03", calendar_days: 50 },
  } as ClientMeta, clients: new Map(),
}));
assert.match(profile(0), /Lượt lấy mẫu hoàn thành/);
assert.match(profile(0), /0 lượt/);
assert.match(profile(100), /2 lượt/);
assert.match(profile(100), /50 ngày lịch/);
console.log("pickup events and retention cutoff: all assertions passed");
