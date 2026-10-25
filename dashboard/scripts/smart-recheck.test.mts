/**
 * Smart re-check rules (lib/smart-recheck.ts): which assigned jobs may be looked
 * at again, and when a better driver is better ENOUGH to move the job.
 *
 * Also the load cap: a driver with MAX_OPEN_TASKS open jobs is left out of smart
 * ranking, unless that leaves nobody.
 *
 * Plus the one trap the re-check exists around: the driver holding a job must be
 * measured with that job taken off their route. Left on, its pickup is their next
 * stop, they score 0 to it, and the job can never move.
 *
 *   npx tsx scripts/smart-recheck.test.mts
 */
import { isRecheckable, moveGain, RECHECK_MIN_AGE_MIN, RECHECK_MIN_GAIN_MIN } from "../src/lib/smart-recheck";
import { selectReferenceStop, openTasks, withoutFullDrivers, MAX_OPEN_TASKS } from "../src/lib/smart-rank";
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

console.log("Open jobs");
const s2 = (jobId: number, type: number, status: number, extra: Partial<TimelineStop> = {}) =>
  ({ jobId, stopTypeId: type, stopStatusId: status, deliveryWindows: [], ...extra }) as unknown as TimelineStop;
const at = (from: string) => ({ deliveryWindows: [{ stopId: 0, timeFrom: `${from}:00+07`, timeTo: "" }] });
const TEN_AM = 10 * 60;
const plate = [
  s2(1, 1, 4), s2(1, 2, 1),                    // collected, drop-off open → counts
  s2(2, 1, 4), s2(2, 2, 3),                    // collected, at the drop-off → counts
  s2(3, 1, 4), s2(3, 2, 4),                    // delivered → no
  s2(4, 1, 1), s2(4, 2, 1),                    // assigned, not picked up yet → counts
  s2(5, 1, 2), s2(5, 2, 1),                    // driving to the pickup → counts
  s2(6, 1, 5), s2(6, 2, 1),                    // pickup rejected → no
  s2(7, 1, 1, at("11:00")), s2(7, 2, 1),       // window exactly an hour away → counts
  s2(8, 1, 1, at("11:01")), s2(8, 2, 1),       // window 61 min away → no
  s2(9, 1, 1, { lastAssignedPlanId: 77 } as Partial<TimelineStop>), s2(9, 2, 1), // untouched plan slot → no
  s2(10, 1, 3, { lastAssignedPlanId: 77 } as Partial<TimelineStop>), s2(10, 2, 1), // plan slot under way → counts
  s2(11, 3, 1),                                // delivery-only job, open → counts
];
ok("counts collected, assigned and under-way jobs; not far windows, plan slots, done or rejected", openTasks(plate, TEN_AM) === 7);
ok(`the limit is ${MAX_OPEN_TASKS}`, MAX_OPEN_TASKS === 3);
const load: Record<string, number> = { A: 3, B: 2, C: 4 };
const r1 = withoutFullDrivers(["A", "B", "C"], (x) => load[x]);
ok("drivers at 3 or more are left out", r1.pool.join() === "B" && r1.full.join() === "A,C" && !r1.allFull);
const r2 = withoutFullDrivers(["A", "C"], (x) => load[x]);
ok("everyone full → everyone stays, best of them still wins", r2.pool.join() === "A,C" && r2.allFull);
const r3 = withoutFullDrivers(["A", "C"], (x) => load[x], (x) => x === "A");
ok("re-check: the holder stays even at 3, nobody full can take it", r3.pool.join() === "A" && !r3.allFull);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
