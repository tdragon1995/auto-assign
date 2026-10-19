/**
 * Smart re-check rules (lib/smart-recheck.ts): which assigned jobs may be looked
 * at again, and when a better driver is better ENOUGH to move the job.
 *
 * Plus the one trap the re-check exists around: the driver holding a job must be
 * measured with that job taken off their route. Left on, its pickup is their next
 * stop, they score 0 to it, and the job can never move.
 *
 *   npx tsx scripts/smart-recheck.test.mts
 */
import { isRecheckable, moveGain, RECHECK_MIN_AGE_MIN, RECHECK_MIN_GAIN_MIN } from "../src/lib/smart-recheck";
import { selectReferenceStop } from "../src/lib/smart-rank";
import type { Job, TimelineStop } from "../src/lib/types";

let failures = 0;
function ok(label: string, cond: boolean) {
  console.log(`  ${cond ? "ok  " : "FAIL"}   ${label}`);
  if (!cond) failures++;
}

const NOW = Date.parse("2026-10-19T09:00:00+07:00");
const MIN = 60_000;
const job = (driver: string | null, pickupStatus: number, extraPickupStatus?: number): Job =>
  ({
    job_id: 1,
    delivery_driver_id: driver,
    stops: [
      { stop_type_id: 1, stop_status_id: pickupStatus },
      ...(extraPickupStatus != null ? [{ stop_type_id: 1, stop_status_id: extraPickupStatus }] : []),
      { stop_type_id: 2, stop_status_id: 1 },
    ],
  }) as unknown as Job;

console.log("Which jobs are re-checked");
const rec = { d: "A", t: NOW - (RECHECK_MIN_AGE_MIN + 1) * MIN };
ok("engine pick, waiting > 10 min, pickup not started → yes", isRecheckable(job("A", 1), rec, NOW));
ok("no engine record (a person assigned it) → no", !isRecheckable(job("A", 1), undefined, NOW));
ok("driver differs from the record (a person moved it) → no", !isRecheckable(job("B", 1), rec, NOW));
ok("only 9 min with the driver → no", !isRecheckable(job("A", 1), { d: "A", t: NOW - 9 * MIN }, NOW));
ok("exactly 10 min → yes", isRecheckable(job("A", 1), { d: "A", t: NOW - RECHECK_MIN_AGE_MIN * MIN }, NOW));
ok("driver set off for the pickup (en route) → locked", !isRecheckable(job("A", 2), rec, NOW));
ok("arrived at the pickup → locked", !isRecheckable(job("A", 3), rec, NOW));
ok("pickup collected → locked", !isRecheckable(job("A", 4), rec, NOW));
ok("two pickups, one under way → locked", !isRecheckable(job("A", 1, 2), rec, NOW));

console.log("When the job moves");
ok(`${RECHECK_MIN_GAIN_MIN} min sooner → moves, gain ${RECHECK_MIN_GAIN_MIN}`, moveGain("A", 12, "B", 7) === 5);
ok("4 min sooner → stays", moveGain("A", 11, "B", 7) === null);
ok("winner IS the holder → stays", moveGain("A", 30, "A", 0) === null);
ok("winner slower → stays", moveGain("A", 5, "B", 20) === null);

console.log("Holder measured without the job");
const stop = (jobId: number, status: number, lat: number, completed: string | null = null): TimelineStop =>
  ({ jobId, stopTypeId: 1, stopStatusId: status, latitude: lat, longitude: 106.7, customerName: `c${jobId}`,
     activityCompletedTs: completed, activityArrivedTs: null, activityStartedTs: null,
     planId: null, lastAssignedPlanId: null }) as unknown as TimelineStop;
// Holder finished job 7 at lat 10.90, and the re-checked job 9's pickup (lat 10.70) is next.
const route = [stop(7, 4, 10.9, "2026-10-19 08:30:00"), stop(9, 1, 10.7)];
const withJob = selectReferenceStop(route, null);
const withoutJob = selectReferenceStop(route.filter((s) => s.jobId !== 9), null);
ok("with the job on, the holder is anchored ON its pickup", withJob?.lat === 10.7);
ok("with it off, they are anchored where they really are", withoutJob?.lat === 10.9 && withoutJob?.label === "Available");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
