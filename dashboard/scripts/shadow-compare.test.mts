import assert from "node:assert/strict";
import { effectiveRuleKey, shadowDecision } from "../src/lib/shadow-compare";
import { dutyRows } from "../src/lib/day-config";
import type { Config, Job } from "../src/lib/types";

const pickup = "11111111-1111-4111-8111-111111111111";
const dropoff = "22222222-2222-4222-8222-222222222222";
const driver1 = "33333333-3333-4333-8333-333333333333";
const driver2 = "44444444-4444-4444-8444-444444444444";
const job: Job = { job_id: 123, create_ts: "2026-09-30 10:00:00", stops: [
  { stop_type_id: 1, customer_id: pickup }, { stop_type_id: 2, customer_id: dropoff },
] };
const config = (rows: Record<string, string>[]): Config => ({ mappings: dutyRows(rows), unfinished: [], gaps: [], overlaps: [], branchRules: {}, parsedAt: "" });
const fixed = config([{ customer_id: pickup, driver_id: driver1, dropoff_id: dropoff, shift_start: "09:00", shift_end: "17:00" }]);
assert.equal(shadowDecision(fixed, [], job).status, driver1);
assert.equal(shadowDecision(config([{ customer_id: pickup, driver_id: driver2, dropoff_id: "" }]), [], job).status, driver2);
const smart = config([{ customer_id: pickup, smart_driver_id: `${driver1},${driver2}`, dropoff_id: dropoff }]);
assert.deepEqual(shadowDecision(smart, [], job).driverIds, [driver1, driver2]);
assert.equal(shadowDecision(smart, [], job).mode, "smart");
assert.equal(shadowDecision(config([{ customer_id: pickup, smart_driver_id: driver1 }]), [], job).status, driver1);
assert.equal(effectiveRuleKey(dutyRows([{ customer_id: pickup, driver_id: driver2, smart_driver_id: driver1 }])[0]),
  effectiveRuleKey(dutyRows([{ customer_id: pickup, driver_id: "", smart_driver_id: driver1 }])[0]));
console.log("shadow decisions: fixed, destination and Smart pool passed");
