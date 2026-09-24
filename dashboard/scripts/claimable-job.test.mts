/**
 * "Nhận việc" must never hand over a job that is already in process with its
 * current driver: on site at the pickup taking PODs, pickup collected, or the
 * dropoff already worked. En route to the pickup stays claimable — that is the
 * hand-over the feature exists for.
 *
 *   npx tsx scripts/claimable-job.test.mts
 */
import assert from "node:assert/strict";
import { isClaimableJob } from "../src/lib/job-filters.ts";

const T = "2026-09-24 09:00:00";
const pickup = (status: number, ts: Record<string, string> = {}) => ({ stop_type_id: 1, stop_status_id: status, ...ts });
const dropoff = (status: number, ts: Record<string, string> = {}) => ({ stop_type_id: 2, stop_status_id: status, ...ts });

const cases: [string, Parameters<typeof isClaimableJob>[0], boolean][] = [
  ["untouched job", [pickup(1), dropoff(1)], true],
  ["assignee en route to pickup", [pickup(2, { activity_started_ts: T }), dropoff(1)], true],
  ["assignee arrived, taking PODs", [pickup(3, { activity_arrived_ts: T }), dropoff(1)], false],
  ["arrival stamped, status lags at 2", [pickup(2, { activity_arrived_ts: T }), dropoff(1)], false],
  ["pickup completed", [pickup(4, { activity_completed_ts: T }), dropoff(1)], false],
  ["completion stamped, status lags at 1", [pickup(1, { activity_completed_ts: T }), dropoff(1)], false],
  ["pickup rejected", [pickup(5), dropoff(1)], false],
  ["dropoff finished, pickup reads open", [pickup(1), dropoff(4, { activity_completed_ts: T })], false],
  ["dropoff arrived (POD at drop), pickup reads open", [pickup(2), dropoff(3)], false],
  ["dropoff timestamp only, status lags", [pickup(1), dropoff(1, { activity_arrived_ts: T })], false],
  ["no pickup stop", [dropoff(1)], false],
];

let failed = 0;
for (const [name, stops, want] of cases) {
  try { assert.equal(isClaimableJob(stops), want); console.log(`ok   ${name}`); }
  catch { failed++; console.log(`FAIL ${name} — expected ${want}`); }
}
if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log(`all ${cases.length} passed`);
