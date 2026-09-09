/**
 * Part-time pay: the punch pairing, and what counts as a paid kilometre.
 *
 * Why this is worth a test. Both halves are somebody's wage, and both fail
 * QUIETLY when they fail. A pairing bug pays a two-shift day as one long shift
 * including the gap between them; a job-grouping bug pays the ride between two
 * clinics as a trip. Neither throws, neither shows up in a build, and both are
 * discovered on payday.
 *
 * Section 1 pins the rule the payroll workbook actually applies
 * (2026.08_PT_Records), including the four rows below taken verbatim from its
 * computed output. The rule is NOT "clock in to clock out": the contracted shift
 * is a floor at one end and, with the last task, a ceiling at the other — and the
 * check-out tap is discarded whenever both of those exist.
 *
 *   npx tsx scripts/pay.test.mts
 */
import {
  workedMinutes, payRowsForRoute, hourPayFor, kmPayFor, NO_SHIFT,
  payPeriodOf, payPeriodRange, shiftPayPeriod, payPeriodLabel,
  RATE_PER_HOUR_VND, RATE_PER_KM_VND, type PayPunch, type DayFacts,
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

console.log("\n1. The roster rule (pay.ts/workedMinutes)");

/** A day with a roster window and a last completed task. */
const facts = (start: string | null, end: string | null, lastTask: string | null, firstTask: string | null = null): DayFacts => ({
  shift: { start, end, source: start ? "contract" : null },
  lastTaskAt: lastTask ? `${DAY}T${lastTask}:00+07:00` : null,
  firstTaskAt: firstTask ? `${DAY}T${firstTask}:00+07:00` : null,
});

// ── The four rows below are copied from the workbook's own computed output. ──
// Each one is a case where the naive "tap to tap" answer is wrong, which is the
// entire reason this function is not a subtraction.

// Row 6: tapped out at 15:31, two and a half hours after a shift ending 13:00.
// The workbook pays to 13:00 — the tap is discarded outright.
let w = workedMinutes([punch("in", "08:04"), punch("out", "15:31")], facts("08:00", "13:00", "11:40"));
check("a late tap is capped at the shift end", w.out_at === "13:00", String(w.out_at));
check("...and the day is 4h56", w.minutes === 296, String(w.minutes));

// Row 7: tapped out at 20:53, before a shift ending 21:00. Paid to 21:00 anyway.
w = workedMinutes([punch("in", "06:00"), punch("out", "20:53")], facts("06:00", "21:00", "19:56"));
check("stopping early still pays to the shift end", w.out_at === "21:00", String(w.out_at));
check("...15 hours exactly", w.minutes === 900, String(w.minutes));

// Row 8: a plainly wrong 15:00 check-out tap on a shift ending 21:00, with work
// finishing 21:15. Paid to the last task.
w = workedMinutes([punch("in", "15:00"), punch("out", "15:00")], facts("15:00", "21:00", "21:15"));
check("work past the shift end pays to the last task", w.out_at === "21:15", String(w.out_at));
check("...and names that as the basis", w.out_basis === "last_task", String(w.out_basis));

// Row 23: tapped out at 22:01, 48 minutes after the last task. Capped at 21:13.
w = workedMinutes([punch("in", "17:00"), punch("out", "22:01")], facts("17:00", "21:00", "21:13"));
check("overtime is capped at real work, not the tap", w.out_at === "21:13", String(w.out_at));

// ── The in-clock is a floor, never a bonus ──────────────────────────────────
w = workedMinutes([punch("in", "05:30"), punch("out", "12:00")], facts("06:00", "12:00", "11:40"));
check("arriving early earns nothing", w.in_at === "06:00" && w.minutes === 360, `${w.in_at} ${w.minutes}`);
check("...and says the shift set it", w.in_basis === "shift_start", String(w.in_basis));

w = workedMinutes([punch("in", "06:07"), punch("out", "19:10")], facts("06:00", "19:00", "19:10"));
check("arriving late starts the clock late", w.in_at === "06:07" && w.in_basis === "tap", String(w.in_at));

// ── THE REGRESSION THIS REWRITE EXISTS FOR ──────────────────────────────────
// The old rule paid ZERO for a shift with no check-out. On the payroll data that
// was 51 of 1,076 driver-days (5%), plus 29 with no check-in (3%).
w = workedMinutes([punch("in", "15:00")], facts("15:00", "21:00", "20:30"));
check("a forgotten check-out does NOT zero the day", w.minutes === 360, String(w.minutes));
check("...it pays to the shift end", w.out_at === "21:00", String(w.out_at));
check("...and the unpaired tap is still reported", w.open_in.length === 1);

// No check-in tap either: the workbook falls back to the first task, then floors
// it at the shift start.
// The shift start is a FLOOR, not a start gun: a driver whose first task was
// 15:33 is paid from 15:33, not from the 15:00 the roster opens at. Only a tap
// EARLIER than the shift gets lifted.
w = workedMinutes([], facts("15:00", "21:00", "20:30", "15:33"));
check("no taps at all still pays, from the first task to the shift end",
  w.minutes === 327 && w.in_at === "15:33" && w.out_at === "21:00", `${w.in_at}-${w.out_at} ${w.minutes}`);
check("...naming the first task as the basis", w.in_basis === "first_task", String(w.in_basis));
w = workedMinutes([], facts(null, null, "20:30", "15:33"));
check("with no shift either, it spans first task to last", w.minutes === 297, String(w.minutes));
check("...and flags itself as not the payroll figure", w.missing_shift === true);

// ── Degradation without a roster window ─────────────────────────────────────
w = workedMinutes([punch("in", "08:00"), punch("out", "12:30")], { shift: NO_SHIFT, lastTaskAt: null, firstTaskAt: null });
check("no shift → falls back to raw taps", w.minutes === 270, String(w.minutes));
check("...marked provisional", w.missing_shift === true);
check("...and names the tap as the basis", w.out_basis === "tap", String(w.out_basis));

// ── Split shifts collapse into ONE span, unlike the old rule ────────────────
// The workbook takes the first tap of each kind and closes on the roster, so a
// driver with a morning and an evening shift on one roster line is paid straight
// through. Pinned because it is a deliberate behaviour change, not an accident.
w = workedMinutes(
  [punch("in", "08:00"), punch("out", "12:00"), punch("in", "17:00"), punch("out", "20:00")],
  facts("08:00", "20:00", "19:50"),
);
check("two taps in a day are ONE span under the roster rule", w.minutes === 720, String(w.minutes));

// ── Nonsense is reported, never silently paid ───────────────────────────────
w = workedMinutes([punch("in", "18:00")], facts("18:00", "09:00", "08:30"));
check("an out before an in pays zero", w.minutes === 0);
check("...and is flagged", w.inverted === true);

check("no data at all is zero, not a crash", workedMinutes([]).minutes === 0);

console.log("\n2. The pay period runs 15th -> 14th");

// The workbook "2026.08_PT_Records_Vận_14.08" covers 15/07 - 14/08, so a period
// is named for the month it ENDS in. Getting this backwards would name every
// period for the month it is mostly not.
let r = payPeriodRange("2026-08");
check("2026-08 is 15/07 - 14/08", r.from === "2026-07-15" && r.to === "2026-08-14", `${r.from}..${r.to}`);

check("the 14th closes its period", payPeriodOf("2026-08-14") === "2026-08");
check("the 15th opens the next one", payPeriodOf("2026-08-15") === "2026-09");
check("the 1st belongs to the period that ENDS that month", payPeriodOf("2026-08-01") === "2026-08");
check("the last day of a month rolls forward", payPeriodOf("2026-08-31") === "2026-09");

// December -> January is where naive month arithmetic breaks.
r = payPeriodRange("2027-01");
check("a period can cross the year boundary", r.from === "2026-12-15" && r.to === "2027-01-14", `${r.from}..${r.to}`);
check("...and stepping back from it lands in December", shiftPayPeriod("2027-01", -1) === "2026-12");
check("31/12 belongs to the January period", payPeriodOf("2026-12-31") === "2027-01");

// A short February must not shorten the period: the boundary is a day number,
// not an offset from the month end.
r = payPeriodRange("2027-03");
check("February's length does not move the boundary", r.from === "2027-02-15" && r.to === "2027-03-14", `${r.from}..${r.to}`);

check("every day lands in exactly one period", (() => {
  // Walk a year and check the periods tile the days with no gap or overlap.
  const d = new Date(Date.UTC(2026, 0, 1));
  let prev: string | null = null;
  for (let i = 0; i < 400; i++) {
    const iso = d.toISOString().slice(0, 10);
    const p = payPeriodOf(iso);
    const { from, to } = payPeriodRange(p);
    if (iso < from || iso > to) return false;
    if (prev && p !== prev && p !== shiftPayPeriod(prev, 1)) return false;
    prev = p;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return true;
})());

check("the label reads as the span, not a month", payPeriodLabel("2026-08") === "15/07 – 14/08", payPeriodLabel("2026-08"));

console.log("\n3. Money");

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

console.log("\n4. What earns a kilometre");

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
// customerId and coords vary per clinic, as they do in real data — the
// merged-visit rule keys on the PLACE, so a fixture leaving them constant would
// collapse three separate collections into one ride and prove nothing.
const threeJobs = payRowsForRoute(route([
  stop({ jobId: 11, stopId: 1, stopTypeId: 1, customerId: "C1", customerName: "Clinic 1", latitude: 10.71 }),
  stop({ jobId: 12, stopId: 2, stopTypeId: 1, customerId: "C2", customerName: "Clinic 2", latitude: 10.72 }),
  stop({ jobId: 13, stopId: 3, stopTypeId: 1, customerId: "C3", customerName: "Clinic 3", latitude: 10.73 }),
  stop({ jobId: 11, stopId: 4, stopTypeId: 2, customerId: "D1", customerName: "BRA - D001", latitude: 10.80 }),
  stop({ jobId: 12, stopId: 5, stopTypeId: 2, customerId: "D1", customerName: "BRA - D001", latitude: 10.80 }),
  stop({ jobId: 13, stopId: 6, stopTypeId: 2, customerId: "D1", customerName: "BRA - D001", latitude: 10.80 }),
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

console.log("\n5. What does NOT earn a kilometre");

const RET = "🛵 Vận chuyển mẫu PSC (về)";
const VIA = "🛵 Vận chuyển mẫu PSC (ghé)";

// A return leg carries nothing back. It IS a real ride and TAT counts its
// distance; pay measures what was DELIVERED, and this delivered nothing.
const withReturn = payRowsForRoute(route([
  stop({ jobId: 61, stopId: 20, stopTypeId: 1, customerId: "D1", customerName: "BRA - D001", jobLabels: [{ label: RET }] }),
  stop({ jobId: 61, stopId: 21, stopTypeId: 2, customerId: "C9", customerName: "BRA - D011", jobLabels: [{ label: RET }] }),
]), DAY);
check("a return leg earns nothing", withReturn.jobs.length === 0, String(withReturn.jobs.length));

// A via leg is a deliberate second pickup on an existing run. With a batch it
// moved samples; with none it collected nothing, so there is nothing to pay for.
const viaEmpty = payRowsForRoute(route([
  stop({ jobId: 62, stopId: 22, stopTypeId: 1, customerId: "CV", customerName: "Clinic V", jobLabels: [{ label: VIA }], itemTrackingNumbers: [] }),
  stop({ jobId: 62, stopId: 23, stopTypeId: 2, customerId: "D1", customerName: "BRA - D001", jobLabels: [{ label: VIA }], itemTrackingNumbers: [] }),
]), DAY);
check("a via leg carrying no batch earns nothing", viaEmpty.jobs.length === 0, String(viaEmpty.jobs.length));

const viaLoaded = payRowsForRoute(route([
  stop({ jobId: 63, stopId: 24, stopTypeId: 1, customerId: "CV", customerName: "Clinic V", jobLabels: [{ label: VIA }], itemTrackingNumbers: ["B011260715065606"] }),
  stop({ jobId: 63, stopId: 25, stopTypeId: 2, customerId: "D1", customerName: "BRA - D001", jobLabels: [{ label: VIA }] }),
]), DAY);
check("a via leg WITH a batch is paid like any trip", viaLoaded.jobs.length === 1, String(viaLoaded.jobs.length));

// Two jobs collected on ONE visit and delivered on ONE visit rode together, so
// the driver is paid once however many batches came along.
const merged = payRowsForRoute(route([
  stop({ jobId: 71, stopId: 30, stopTypeId: 1, customerId: "C1", customerName: "Clinic 1", latitude: 10.71, activityCompletedTs: `${DAY} 09:00:00` }),
  stop({ jobId: 72, stopId: 31, stopTypeId: 1, customerId: "C1", customerName: "Clinic 1", latitude: 10.71, activityCompletedTs: `${DAY} 09:03:00` }),
  stop({ jobId: 71, stopId: 32, stopTypeId: 2, customerId: "D1", customerName: "BRA - D001", latitude: 10.80, activityCompletedTs: `${DAY} 10:00:00` }),
  stop({ jobId: 72, stopId: 33, stopTypeId: 2, customerId: "D1", customerName: "BRA - D001", latitude: 10.80, activityCompletedTs: `${DAY} 10:02:00` }),
]), DAY);
check("two jobs riding together are paid once", merged.jobs.length === 1, String(merged.jobs.length));

// THE CASE THAT MUST NOT COLLAPSE. The shuttle runs repeat the same pair every
// hour or so all afternoon and those are separate rides. Grouping by
// driver+day+pair instead of by VISIT collapses 36.7% of every job in the
// payroll period — 1,930 real payments — which is why the rule is
// consecutiveness and not a time window.
const shuttle = payRowsForRoute(route([
  stop({ jobId: 81, stopId: 40, stopTypeId: 1, customerId: "C2", customerName: "BRA - D002", latitude: 10.72, activityCompletedTs: `${DAY} 15:19:00` }),
  stop({ jobId: 81, stopId: 41, stopTypeId: 2, customerId: "D1", customerName: "BRA - D001", latitude: 10.80, activityCompletedTs: `${DAY} 15:55:00` }),
  stop({ jobId: 82, stopId: 42, stopTypeId: 1, customerId: "C2", customerName: "BRA - D002", latitude: 10.72, activityCompletedTs: `${DAY} 16:46:00` }),
  stop({ jobId: 82, stopId: 43, stopTypeId: 2, customerId: "D1", customerName: "BRA - D001", latitude: 10.80, activityCompletedTs: `${DAY} 17:20:00` }),
  stop({ jobId: 83, stopId: 44, stopTypeId: 1, customerId: "C2", customerName: "BRA - D002", latitude: 10.72, activityCompletedTs: `${DAY} 17:40:00` }),
  stop({ jobId: 83, stopId: 45, stopTypeId: 2, customerId: "D1", customerName: "BRA - D001", latitude: 10.80, activityCompletedTs: `${DAY} 18:20:00` }),
]), DAY);
check("the same pair ridden three times pays three times", shuttle.jobs.length === 3, String(shuttle.jobs.length));

console.log("\n6. Chấm công is a punch, never a paid job");

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
check("and with no roster they bound a 9h10 day", workedMinutes(withChamCong.punches).minutes === 550,
  String(workedMinutes(withChamCong.punches).minutes));

// Labels arrive as objects over JSON-RPC and as strings over REST; the reference
// number is the fallback when a payload carries neither.
const refOnly = payRowsForRoute(route([
  stop({ jobId: 51, stopId: 14, stopTypeId: 3, referenceNumber: "Chấm Công - Ra", jobLabels: [] }),
]), DAY);
check("an unlabelled tap is read off its reference number", refOnly.punches[0]?.kind === "out");

console.log("\n7. Timestamps carry VN's offset, not the server's guess");
check("a completion stamp becomes +07:00",
  withChamCong.jobs[0].dropoff_completed_ts === `${DAY}T09:00:00+07:00`,
  String(withChamCong.jobs[0].dropoff_completed_ts));


console.log("\n8. The roster grid decides whether a day is priced");

const { resolveGridDate, parseGridCell, buildShiftGrid, lookupShift } =
  await import("../src/lib/shift-grid");

check("a window parses", JSON.stringify(parseGridCell("6:00-15:00")) === '{"start":"06:00","end":"15:00"}',
  JSON.stringify(parseGridCell("6:00-15:00")));
check("'P' is not a shift", parseGridCell("P") === null);
check("'Quốc khánh' is not a shift", parseGridCell("Quốc khánh") === null);
check("blank is not a shift", parseGridCell("") === null);

// Headers carry no year, so each column takes the year nearest today. This has
// to survive a December→January boundary in BOTH directions.
check("1/8 near an August today", resolveGridDate("1/8", "2026-08-20") === "2026-08-01");
check("2/1 read from late December is NEXT year",
  resolveGridDate("2/1", "2026-12-28") === "2027-01-02", String(resolveGridDate("2/1", "2026-12-28")));
check("28/12 read from early January is LAST year",
  resolveGridDate("28/12", "2027-01-03") === "2026-12-28", String(resolveGridDate("28/12", "2027-01-03")));
check("31/2 does not silently become 3 March", resolveGridDate("31/2", "2026-02-10") === null);

const grid = buildShiftGrid([
  { "Nhân viên": "", "Mã NV": "", "1/8": "T7", "2/8": "CN" },          // weekday strip
  { "Nhân viên": "A", "Mã NV": "PT101705", "1/8": "15:00-21:00", "2/8": "" },
  { "Nhân viên": "B", "Mã NV": "PT101574", "1/8": "P", "2/8": "17:00-20:30" },
], "2026-08-05");

check("the weekday strip is not a driver", grid.drivers.size === 2, String(grid.drivers.size));
check("a rostered day resolves",
  lookupShift(grid, "PT101705", "2026-08-01").shift?.start === "15:00");
check("a blank cell is a day off, not missing data",
  lookupShift(grid, "PT101705", "2026-08-02").reason === "day-off");
check("'P' reads as not working", lookupShift(grid, "PT101574", "2026-08-01").reason === "not-working");
check("an unknown driver is no-driver-row",
  lookupShift(grid, "PT999999", "2026-08-01").reason === "no-driver-row");
check("a date outside the grid says so",
  lookupShift(grid, "PT101705", "2026-07-15").reason === "date-not-covered");
check("...and NEVER returns a shift it does not have",
  lookupShift(grid, "PT101705", "2026-07-15").shift === null);

console.log(failures === 0 ? "\nAll pay checks passed." : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
