/**
 * A driver may only be ranked from a place they have actually been.
 *
 * The smart ranking measures each driver from ONE anchor point, and the primary
 * sort key is that distance — so an anchor that is merely scheduled competes as
 * hard fact. On 27/08 a route-free driver whose start_location IS the pickup
 * (D006) scored 0 km road and won the Start-Location priority band, while his
 * own GPS put him 6.3 km away; the driver standing on the pickup came second.
 * The same fiction sits inside a route: measured that day, 16 of 17 drivers
 * anchored on a not-yet-started next stop were still on their LAST COMPLETED
 * one, up to 14 km from the anchor they were being scored against.
 *
 * The rule is scoped to CARTRACK PLANS, which lay a driver's whole day out in
 * advance: an untouched stop of a planned job does not anchor them. Two pending
 * stops still do — a stop of a plan job already under way (samples in hand, lab
 * run pending: they are committed to going), and every ad-hoc stop, which was
 * dispatched to this driver on purpose. Where the anchor is dropped, re-anchor
 * onto the best truth available: live GPS → the last stop we know they stood on
 * → start_location.
 *
 * The route-state LABEL never moves with the anchor. Position and availability
 * are separate questions: a driver with 30 planned stops ahead is still the
 * least available one, they are just measured from where they really are.
 */
import { selectReferenceStop, isUnreachedAnchor, liveGpsRef, lastRealPositionRef } from "../src/lib/smart-rank";
import type { TimelineStop } from "../src/lib/types";

let failures = 0;
function ok(label: string, cond: boolean) {
  console.log(`  ${cond ? "ok  " : "FAIL"}   ${label}`);
  if (!cond) failures++;
}

let stopSeq = 0;
function stop(
  jobId: number,
  status: number,
  lat: number,
  lon: number,
  name: string,
  completedTs: string | null = null,
  planId: number | null = 2809794   // plan-marked by default; pass null for ad-hoc
): TimelineStop {
  return {
    stopId: ++stopSeq, jobId, stopTypeId: 1, stopStatusId: status,
    customerId: `cust-${name}`, customerName: name, latitude: lat, longitude: lon,
    activityCompletedTs: completedTs, activityArrivedTs: null, activityStartedTs: null,
    planId: null, lastAssignedPlanId: planId,
  } as unknown as TimelineStop;
}

// ── A driver part-way through a planned day: D035 done, D001 pending on a job
//    they have not touched. They are sitting at D035.
const untouchedNext = [
  stop(100, 4, 10.80, 106.66, "D035", "2026-08-27 06:31:00"),
  stop(200, 1, 10.77, 106.69, "D001"),
];
const refNext = selectReferenceStop(untouchedNext, null);
ok("untouched stop of a PLANNED job is flagged", refNext?.plannedUnstarted === true);
ok("...and is therefore re-anchored", isUnreachedAnchor(refNext));
ok("label stays Next Stop (availability is not position)", refNext?.label === "Next Stop");

const demoted = lastRealPositionRef(refNext!);
ok("no GPS → falls back to the last completed stop", demoted?.lat === 10.80 && demoted?.lon === 106.66);
ok("...and stops being unreached", !isUnreachedAnchor(demoted));
ok("...keeping the Next Stop label", demoted?.label === "Next Stop");

const gps = liveGpsRef(refNext!, 10.801, 106.661, null);
ok("GPS wins over both points when we have a fix", gps.lat === 10.801 && gps.lon === 106.661);
ok("...and the flattering alt point is dropped", gps.altLat == null && gps.altLon == null);
ok("...label still Next Stop", gps.label === "Next Stop");

// ── Same shape, but the driver already collected for that job: pickup done,
//    dropoff pending. They are committed to D001 — a real destination.
const startedJob = [
  stop(300, 4, 10.80, 106.66, "PK Quốc Tế", "2026-08-27 06:31:00"),
  stop(300, 1, 10.77, 106.69, "D001"),
];
const refStarted = selectReferenceStop(startedJob, null);
ok("stop of a plan job already under way is a real anchor", refStarted?.plannedUnstarted !== true);
ok("...and is left alone", !isUnreachedAnchor(refStarted));
ok("...anchored on the dropoff they are driving to", refStarted?.lat === 10.77);

// ── A driver whose whole day is still pending: nothing started, nothing done.
const untouchedDay = [
  stop(400, 1, 10.75, 106.62, "D006"),
  stop(400, 1, 10.77, 106.69, "D001"),
];
const refFirst = selectReferenceStop(untouchedDay, "2026-08-27 06:00:00");
ok("First Stop of an untouched planned day is flagged", refFirst?.plannedUnstarted === true && refFirst?.label === "First Stop");
ok("...has no last-known position to fall back to", lastRealPositionRef(refFirst!) === null);
ok("...but yields to GPS, keeping the shift-start idle clock",
  liveGpsRef(refFirst!, 10.70, 106.60, null).tiebreakTs === "2026-08-27 06:00:00");

// ── The same shape with NO plan marker: an ad-hoc job was dispatched to this
//    driver on purpose, so its stop keeps anchoring them even unstarted.
const adhocNext = [
  stop(700, 4, 10.80, 106.66, "D035", "2026-08-27 06:31:00", null),
  stop(800, 1, 10.77, 106.69, "D001", null, null),
];
const refAdhoc = selectReferenceStop(adhocNext, null);
ok("untouched AD-HOC stop is not flagged", refAdhoc?.plannedUnstarted !== true);
ok("...and is left anchoring the driver", !isUnreachedAnchor(refAdhoc));
ok("...on the stop they were dispatched to", refAdhoc?.lat === 10.77);

const adhocDay = [stop(900, 1, 10.75, 106.62, "D006", null, null)];
ok("an ad-hoc First Stop is left alone too", !isUnreachedAnchor(selectReferenceStop(adhocDay, null)));

// ── Stops the driver is physically at are never overridden.
const arrived = selectReferenceStop([stop(500, 3, 10.75, 106.62, "D006")], null);
ok("an Arrived stop is a fact", arrived?.label === "Arrived" && !isUnreachedAnchor(arrived));
const enRoute = selectReferenceStop([stop(600, 2, 10.75, 106.62, "D006")], null);
ok("an En Route stop is a fact", enRoute?.label === "En Route" && !isUnreachedAnchor(enRoute));

// ── No route at all → the caller's start_location fallback, which GPS outranks.
ok("no route reads as unreached", isUnreachedAnchor(null));
const noRoute = liveGpsRef(null, 10.70, 106.60, "2026-08-27 06:00:00");
ok("...GPS anchor keeps the route-free Start Location band", noRoute.label === "Start Location");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
