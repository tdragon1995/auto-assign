/**
 * Part-time pay: the punch pairing, and what counts as a paid kilometre.
 *
 * Why this is worth a test. Both halves are somebody's wage, and both fail
 * QUIETLY when they fail. A pairing bug pays a two-shift day as one long shift
 * including the gap between them; a job-grouping bug pays the ride between two
 * clinics as a trip. Neither throws, neither shows up in a build, and both are
 * discovered on payday.
 *
 * The pairing rule is PROVISIONAL (see pay.ts/workedMinutes) — when the payroll
 * formula is settled, section 1 is the thing to rewrite, and it is deliberately
 * the only place in the codebase that has to change.
 *
 *   npx tsx scripts/pay.test.mts
 */
import {
  workedMinutes, payRowsForRoute, hourPayFor, kmPayFor,
  RATE_PER_HOUR_VND, RATE_PER_KM_VND, type PayPunch,
} from "../src/lib/pay";
import type { TimelineRoute, TimelineStop } from "../src/lib/types";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const DAY = "2026-09-01";

/** A punch as the archive stores it. Only the completed stamp is set, which is
 *  what punchAt() prefers and what a normally-tapped chấm-công job carries. */
const punch = (kind: "in" | "out", hhmm: string): PayPunch => ({
  trip_date: DAY,
  driver_id: "d1",
  driver_name: "P - C - PT100001 Nguyễn Văn A",
  job_id: Math.random(),
  kind,
  customer_id: null,
  location_name: null,
  started_ts: null,
  arrived_ts: null,
  completed_ts: `${DAY}T${hhmm}:00+07:00`,
  job_status_id: 5,
});

console.log("\n1. Punch pairing (PROVISIONAL formula — pay.ts/workedMinutes)");

const oneShift = workedMinutes([punch("in", "08:00"), punch("out", "12:30")]);
check("one shift is its own length", oneShift.minutes === 270, String(oneShift.minutes));
check("and is reported as one span", oneShift.spans.length === 1);

// The reason pairing exists at all. A driver working 08:00-12:00 and 17:00-20:00
// worked seven hours, not twelve — the five hours between shifts are not paid.
const twoShifts = workedMinutes([
  punch("in", "08:00"), punch("out", "12:00"),
  punch("in", "17:00"), punch("out", "20:00"),
]);
check("two shifts sum, the gap between them does not", twoShifts.minutes === 420, String(twoShifts.minutes));
check("both spans are shown", twoShifts.spans.length === 2);

// Taps arrive from the day's routes in route order, not clock order.
const shuffled = workedMinutes([
  punch("out", "20:00"), punch("in", "08:00"),
  punch("out", "12:00"), punch("in", "17:00"),
]);
check("order of arrival does not matter", shuffled.minutes === 420, String(shuffled.minutes));

// A forgotten check-out pays NOTHING for that shift and says so, rather than
// being closed at some plausible-looking later moment.
const forgot = workedMinutes([punch("in", "08:00"), punch("out", "12:00"), punch("in", "17:00")]);
check("an unclosed shift pays nothing", forgot.minutes === 240, String(forgot.minutes));
check("and is reported, not swallowed", forgot.open_in.length === 1);

// Two check-ins running: the later one is the shift actually open, the earlier
// is an orphan. Keeping the FIRST would pay the gap between them.
const doubleIn = workedMinutes([punch("in", "08:00"), punch("in", "09:00"), punch("out", "12:00")]);
check("two check-ins in a row keep the later", doubleIn.minutes === 180, String(doubleIn.minutes));
check("and report the orphan", doubleIn.open_in.length === 1);

const strayOut = workedMinutes([punch("out", "08:00"), punch("in", "09:00"), punch("out", "12:00")]);
check("a check-out with no check-in pays nothing", strayOut.minutes === 180, String(strayOut.minutes));
check("and is reported", strayOut.stray_out.length === 1);

check("no taps at all is zero, not a crash", workedMinutes([]).minutes === 0);

console.log("\n2. Money");

check("30.000đ/h is charged per minute", hourPayFor(60) === 30_000 && hourPayFor(30) === 15_000);
check("a 20-minute shift is not rounded away", hourPayFor(20) === 10_000, String(hourPayFor(20)));
check("2.000đ/km", kmPayFor(3.5) === 7_000, String(kmPayFor(3.5)));
check("rates are the stated contract", RATE_PER_HOUR_VND === 30_000 && RATE_PER_KM_VND === 2_000);

// The reason totals price the SUMMED kilometres rather than adding per-job đồng.
const legs = [1.115, 2.225, 3.335];
const perJob = legs.reduce((s, km) => s + kmPayFor(km), 0);
const summed = kmPayFor(Math.round(legs.reduce((s, km) => s + km, 0) * 100) / 100);
check("summing km then pricing differs from summing prices (hence the rule)", perJob !== summed,
  `${perJob} vs ${summed}`);

console.log("\n3. What earns a kilometre");

const stop = (o: Partial<TimelineStop>): TimelineStop => ({
  stopId: 1, jobId: 1, stopTypeId: 1, stopStatusId: 4,
  customerId: "C1", customerName: "PSC A", deliveryDriverId: "d1",
  referenceNumber: "REF", orderId: "", sendToDriverAt: null, allowedToStartAt: null,
  scheduledDeliveryTs: null, isPlanning: false, firstStopStatusId: 1, deliveryDate: DAY,
  jobStatusId: 5, deliveryWindows: [], jobLabels: [],
  latitude: 10.7, longitude: 106.7, addressLine1: null, addressLine2: null,
  postalCode: null, countryId: null, subuserId: null, clientReference: null,
  expectedDurationInMinutes: null, itemTrackingNumbers: [], itemsWeightInKg: null,
  itemsVolumeInCubicCm: null, requiredCapabilities: [], isCourierJob: false,
  isForceCompleted: false, activityCompletedTs: `${DAY} 09:00:00`,
  activityArrivedTs: null, activityStartedTs: null, activityRejectedTs: null,
  rejectedByName: null, ...o,
} as TimelineStop);

const route = (stops: TimelineStop[]): TimelineRoute =>
  ({ routeId: "driver_d1", driverFullname: "P - C - PT100001 Nguyễn Văn A", orderedStops: stops } as TimelineRoute);

// THE CENTRAL CASE, and the one footgun 7 warns about. Three clinics collected
// before one lab run: three JOBS (three paid pickup→dropoff pairs), which is not
// the same set of distances as the four LEGS the driver rode. Note the stops are
// interleaved — a job's pickup and dropoff are usually NOT consecutive.
const threeJobs = payRowsForRoute(route([
  stop({ jobId: 11, stopId: 1, stopTypeId: 1, customerName: "Clinic 1" }),
  stop({ jobId: 12, stopId: 2, stopTypeId: 1, customerName: "Clinic 2" }),
  stop({ jobId: 13, stopId: 3, stopTypeId: 1, customerName: "Clinic 3" }),
  stop({ jobId: 11, stopId: 4, stopTypeId: 2, customerName: "BRA - D001" }),
  stop({ jobId: 12, stopId: 5, stopTypeId: 2, customerName: "BRA - D001" }),
  stop({ jobId: 13, stopId: 6, stopTypeId: 2, customerName: "BRA - D001" }),
]), DAY);
check("three jobs collected then delivered are three paid jobs", threeJobs.jobs.length === 3,
  String(threeJobs.jobs.length));
check("each pairs its OWN pickup with its own dropoff",
  threeJobs.jobs.every((j) => j.dropoff_name === "BRA - D001") &&
  new Set(threeJobs.jobs.map((j) => j.pickup_name)).size === 3);

const unfinished = payRowsForRoute(route([
  stop({ jobId: 21, stopId: 7, stopTypeId: 1, jobStatusId: 4 }),
  stop({ jobId: 21, stopId: 8, stopTypeId: 2, jobStatusId: 4 }),
]), DAY);
check("an unfinished job earns nothing", unfinished.jobs.length === 0);

const singleStop = payRowsForRoute(route([
  stop({ jobId: 31, stopId: 9, stopTypeId: 3 }),
]), DAY);
check("a single-stop job has no pickup→dropoff pair and earns nothing", singleStop.jobs.length === 0);

console.log("\n4. Chấm công is a punch, never a paid job");

const withChamCong = payRowsForRoute(route([
  stop({ jobId: 41, stopId: 10, stopTypeId: 3, referenceNumber: "Chấm Công - Vào",
        jobLabels: [{ label: "check_in" }], activityCompletedTs: `${DAY} 07:55:00` }),
  stop({ jobId: 42, stopId: 11, stopTypeId: 1, customerName: "Clinic 1" }),
  stop({ jobId: 42, stopId: 12, stopTypeId: 2, customerName: "BRA - D001" }),
  stop({ jobId: 43, stopId: 13, stopTypeId: 3, referenceNumber: "Chấm Công - Ra",
        jobLabels: [{ label: "check_out" }], activityCompletedTs: `${DAY} 17:05:00` }),
]), DAY);
check("chấm công does not become a paid job", withChamCong.jobs.length === 1, String(withChamCong.jobs.length));
check("it becomes two punches", withChamCong.punches.length === 2);
check("pointing the right ways",
  withChamCong.punches[0].kind === "in" && withChamCong.punches[1].kind === "out");
check("and the day they bound is 9h10", workedMinutes(withChamCong.punches).minutes === 550,
  String(workedMinutes(withChamCong.punches).minutes));

// Labels arrive as objects over JSON-RPC and as strings over REST; the reference
// number is the fallback when a payload carries neither.
const refOnly = payRowsForRoute(route([
  stop({ jobId: 51, stopId: 14, stopTypeId: 3, referenceNumber: "Chấm Công - Ra", jobLabels: [] }),
]), DAY);
check("an unlabelled tap is read off its reference number", refOnly.punches[0]?.kind === "out");

console.log("\n5. Timestamps carry VN's offset, not the server's guess");
check("a completion stamp becomes +07:00",
  withChamCong.jobs[0].dropoff_completed_ts === `${DAY}T09:00:00+07:00`,
  String(withChamCong.jobs[0].dropoff_completed_ts));

console.log(failures === 0 ? "\nAll pay checks passed." : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
