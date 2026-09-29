import assert from "node:assert/strict";
import { buildActiveRouteMap, isDuplicateExemptJob } from "../src/lib/assign";

const job = (id: number, labels: string[] = [], planId: number | null = null) => ({
  job_id: id,
  job_status_id: 4,
  labels,
  last_assigned_plan_id: planId,
  stops: [
    { stop_type_id: 1, stop_status_id: 1, customer_id: "pickup" },
    { stop_type_id: 2, customer_id: "dropoff" },
  ],
});

const scheduled = job(1, ["📅 Lịch cố định"]);
const adHoc = job(2);
const cartrackPlan = job(3, [], 2811861);
assert.equal(isDuplicateExemptJob(scheduled), true);
assert.equal(isDuplicateExemptJob(adHoc), false);
assert.equal(isDuplicateExemptJob(cartrackPlan), false);
assert.equal(buildActiveRouteMap([scheduled]).size, 0);
assert.equal(buildActiveRouteMap([scheduled, adHoc]).get("pickup:dropoff"), 2);
