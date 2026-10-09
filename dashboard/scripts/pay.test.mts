/**
 * Part-time pay: the hours rule, and what counts as a paid kilometre.
 *
 * Why this is worth a test. Both halves are somebody's wage, and both fail
 * QUIETLY when they fail. A pairing bug pays a two-shift day as one long shift
 * including the gap between them; a job-grouping bug pays the ride between two
 * clinics as a trip. Neither throws, neither shows up in a build, and both are
 * discovered on payday.
 *
 * Section 1 pins the hours rule to days copied from payroll's own 15/08-14/09
 * file, so a change to workedMinutes that stops reproducing payroll fails here.
 *
 *   npx tsx scripts/pay.test.mts
 */
import {
  workedMinutes, payRowsForRoute, hourPayFor, kmPayFor, dropSameTripDuplicates, paidDay, hoursPayFor,
  RATE_PER_HOUR_VND, RATE_PER_KM_VND, type PayPunch,
} from "../src/lib/pay";
import { parsePayrollSheet, resolveDriver } from "../src/lib/pay-shifts";
import { openRange, checkTimes, checkProof } from "../src/lib/pay-corrections";
import type { TimelineRoute, TimelineStop } from "../src/lib/types";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const DAY = "2026-08-15";

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

console.log("\n1. Hours — payroll's rule on payroll's shift (pay.ts/workedMinutes)");

const at = (hhmm: string, date = DAY) => `${date}T${hhmm}:00+07:00`;
const facts = (shifts: [string, string][], first: string | null, last: string | null, date = DAY) => ({
  date, shifts: shifts.map(([start, end]) => ({ start, end })),
  firstTaskAt: first ? at(first, date) : null, lastTaskAt: last ? at(last, date) : null,
});

// Bùi Ngọc Thành 15/08: shift 12:00–20:00, tapped in 12:23, last trip 20:02 → 7.65 h.
const late = workedMinutes([punch("in", "12:23")], facts([["12:00", "20:00"]], "12:40", "20:02"));
check("late tap-in starts the clock; last trip past shift end extends it", late.minutes === 459, String(late.minutes));

// Arriving early earns nothing; tapping out before shift end ends the paid day
// there (supervisor, 2026-10-09: never pay later than the tap-out).
const early = workedMinutes([punch("in", "16:35"), punch("out", "19:10")], facts([["17:00", "20:00"]], "17:10", "19:05"));
check("early tap-in clamps to shift start, an early tap-out ends the day", early.minutes === 130, String(early.minutes));

// Lâm Sơn Tuấn 03/09: 19:00–19:30 slot, last trip 19:08, tapped out 19:08 → 8 min.
const shortSlot = workedMinutes([punch("in", "18:49"), punch("out", "19:08")], facts([["19:00", "19:30"]], "18:55", "19:08"));
check("tap-out with the last trip: paid to there, not the shift end", shortSlot.minutes === 8, String(shortSlot.minutes));

// A trip finished AFTER the tap-out is still paid to the trip.
const tripAfter = workedMinutes([punch("in", "18:49"), punch("out", "19:08")], facts([["19:00", "19:30"]], "18:55", "19:20"));
check("a trip after the tap-out is paid to the trip", tripAfter.minutes === 20, String(tripAfter.minutes));

// A late check-out tap is not paid time when there were trips: the last trip says when work stopped.
const lateOut = workedMinutes([punch("in", "17:00"), punch("out", "23:00")], facts([["17:00", "21:00"]], "17:05", "20:30"));
check("a late check-out tap is not paid", lateOut.minutes === 240, String(lateOut.minutes));

// The check-in counts from ARRIVAL — Đỗ Hữu Hùng 26/08 arrived 14:55 and
// completed it at 17:38; payroll paid from 15:00.
const opened = workedMinutes(
  [{ ...punch("in", "17:38"), started_ts: at("14:55"), arrived_ts: at("14:55") }],
  facts([["15:00", "21:00"]], "17:38", "21:27"),
);
check("check-in counts from arrival, not completion", opened.minutes === 387, String(opened.minutes));

// No taps: the first pickup opens the shift (supervisor, 2026-09-22), and with
// no check-out the last trip closes it.
const noTap = workedMinutes([], facts([["06:00", "15:00"]], "06:25", "14:00"));
check("no tap → first pickup opens, last trip closes", noTap.minutes === 455, String(noTap.minutes));

// Trips but no check-out: nothing says they stayed on — payroll pays to the last
// trip (47 of 49 such days). Nguyễn Thanh Tú 19/08: 06:31–10:59 on a 06:00–15:00 shift.
const leftEarly = workedMinutes([punch("in", "06:31")], facts([["06:00", "15:00"]], "06:50", "10:59"));
check("no check-out → paid to the last trip", leftEarly.minutes === 268, String(leftEarly.minutes));

// No trips at all: the check-out tap is the only evidence, even a few minutes past
// shift end. Trần Thị Mộng Hoa 15/08: 15:00–21:06 on a 15:00–21:00 shift.
const noTrips = workedMinutes([punch("in", "14:58"), punch("out", "21:06")], facts([["15:00", "21:00"]], null, null));
check("no trips → paid to the check-out tap", noTrips.minutes === 366, String(noTrips.minutes));

// A check-out before the check-in is a stray tap. Trần Minh Nhật 31/08: in 15:35,
// "out" 15:30, shift 15:00–16:00 → paid 15:35–16:00.
const stray = workedMinutes([punch("in", "15:35"), punch("out", "15:30")], facts([["15:00", "16:00"]], null, null));
check("a check-out before the check-in is ignored", stray.minutes === 25, String(stray.minutes));

// The REAL shape of that day: the check-out was opened at 16:21 and only reached
// three days later (03/09 15:30). Counted, it paid 72 h; a tap stamped on another
// date is ignored, so no trips + no same-day check-out → shift end, 25 min.
const lateTap = workedMinutes(
  [punch("in", "15:35"), { ...punch("out", "15:30"), started_ts: at("16:21"), arrived_ts: at("15:30", "2026-09-03"), completed_ts: at("15:30", "2026-09-03") }],
  facts([["15:00", "16:00"]], null, null),
);
check("a tap stamped on another date is ignored", lateTap.minutes === 25, String(lateTap.minutes));

check("a shift on paper with no taps and no trips pays nothing",
  workedMinutes([], facts([["06:00", "15:00"]], null, null)).minutes === 0);

// No shift in payroll's file → no hours, and the day is flagged, never guessed.
const noShift = workedMinutes([punch("in", "07:11"), punch("out", "20:30")], facts([], "08:00", "20:00"));
check("worked without a shift pays no hours", noShift.minutes === 0);
check("and is flagged", noShift.no_shift);
check("an idle day without a shift is not flagged", !workedMinutes([], facts([], null, null)).no_shift);

// Split day: the gap between windows is not paid.
const split = workedMinutes([punch("in", "08:25")], facts([["15:00", "21:00"], ["08:00", "12:00"]], "08:30", "21:01"));
check("split day pays both windows, not the gap", split.minutes === 215 + 361, String(split.minutes));
check("and shows two spans", split.spans.length === 2);

// Quốc khánh is paid at 300% — Kim Thành Tài Huy 02/09: 07:00–12:14 → 15.7 h.
const HOLIDAY = "2026-09-02";
const holiday = workedMinutes(
  [{ ...punch("in", "07:00"), trip_date: HOLIDAY, completed_ts: at("07:00", HOLIDAY) }],
  facts([["07:00", "12:00"]], "07:05", "12:14", HOLIDAY),
);
check("holiday triples the paid minutes", holiday.clocked === 314 && holiday.minutes === 942, `${holiday.clocked}/${holiday.minutes}`);

console.log("\n2. Money");

check("30.000đ/h is charged per minute", hourPayFor(60) === 30_000 && hourPayFor(30) === 15_000);
check("a 20-minute shift is not rounded away", hourPayFor(20) === 10_000, String(hourPayFor(20)));
check("2.000đ/km", kmPayFor(3.5) === 7_000, String(kmPayFor(3.5)));
check("rates are the stated contract", RATE_PER_HOUR_VND === 30_000 && RATE_PER_KM_VND === 2_000);

// BO Runner. Lê Ngọc Anh Tú (PT101705) Mon 17/08: BO 06:04–15:00, then driver
// 15:00–21:30 on payroll's shift → 536 min at 35.000đ + 390 min at 30.000đ.
const tu = { ...facts([["15:00", "21:30"]], "15:58", "21:20", "2026-08-17") };
const tuTaps = [punch("in", "06:04"), punch("out", "15:00"), punch("in", "15:00"), punch("out", "21:30")]
  .map((p) => ({ ...p, trip_date: "2026-08-17", location_name: "BRA - D001", completed_ts: p.completed_ts!.replace(DAY, "2026-08-17") }));
const tuDay = paidDay(tuTaps, tu, "PT101705");
check("BO window added beside the driving shift", tuDay.minutes === 926 && tuDay.bo_minutes === 536, `${tuDay.minutes}/${tuDay.bo_minutes}`);
check("BO minutes at 35.000đ, the rest at 30.000đ", hoursPayFor(tuDay.minutes, tuDay.bo_minutes) === 312_667 + 195_000,
  String(hoursPayFor(tuDay.minutes, tuDay.bo_minutes)));
// Only when he checked in at D001 and ran no trip inside 06:00–15:00.
const tuD019 = paidDay(tuTaps.map((p) => ({ ...p, location_name: "BRA - D019" })), tu, "PT101705");
check("BO needs the check-in at D001", tuD019.bo_minutes === 0 && tuD019.minutes === 390, `${tuD019.minutes}/${tuD019.bo_minutes}`);
const tuDrove = paidDay(tuTaps, { ...tu, firstTaskAt: "2026-08-17T10:15:00+07:00", firstAwayAt: "2026-08-17T10:40:00+07:00" }, "PT101705");
check("left D001 inside the window: no BO, driving", tuDrove.bo_minutes === 0, `${tuDrove.bo_minutes}`);
// 18/08: picked up the K Labtech sendout AT D001 at 14:49, delivered 15:32 —
// the handover into his driving shift, not a morning spent driving.
const tuHandover = paidDay(tuTaps, { ...tu, firstTaskAt: "2026-08-17T14:49:00+07:00", firstAwayAt: "2026-08-17T15:32:00+07:00" }, "PT101705");
check("a pickup at D001 before 15:00 keeps the BO morning", tuHandover.bo_minutes === 536, `${tuHandover.bo_minutes}`);
// Sunday 16/08 he drives 06:00–15:00 on payroll's shift: no BO.
const tuSun = paidDay([], facts([["06:00", "15:00"]], "07:05", "15:27", "2026-08-16"), "PT101705");
check("Sunday is driving, normal rate", tuSun.bo_minutes === 0 && tuSun.minutes > 0, `${tuSun.bo_minutes}`);
// Holiday 01/09: payroll's 07:00–12:00 driving shift covers the window → no BO.
const tuHol = paidDay([], facts([["07:00", "12:00"]], "07:14", "12:36", "2026-09-01"), "PT101705");
check("a payroll shift inside the window is driving, not BO", tuHol.bo_minutes === 0, `${tuHol.bo_minutes}`);
// Trần Thị Mộng Hoa (PT101710): every hour is BO.
const hoa = paidDay([punch("in", "14:53"), punch("out", "21:06")], facts([["15:00", "21:00"]], null, null), "PT101710");
check("Mộng Hoa: all hours at the BO rate", hoa.bo_minutes === hoa.minutes && hoa.minutes === 366, `${hoa.minutes}/${hoa.bo_minutes}`);
check("anyone else: no BO", paidDay([punch("in", "14:53"), punch("out", "21:06")], facts([["15:00", "21:00"]], null, null), "PT100001").bo_minutes === 0);

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
  stop({ jobId: 11, stopId: 1, stopTypeId: 1, customerId: "CL1", customerName: "Clinic 1" }),
  stop({ jobId: 12, stopId: 2, stopTypeId: 1, customerId: "CL2", customerName: "Clinic 2" }),
  stop({ jobId: 13, stopId: 3, stopTypeId: 1, customerId: "CL3", customerName: "Clinic 3" }),
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
  stop({ jobId: 42, stopId: 11, stopTypeId: 1, customerId: "CL1", customerName: "Clinic 1" }),
  stop({ jobId: 42, stopId: 12, stopTypeId: 2, customerName: "BRA - D001" }),
  stop({ jobId: 43, stopId: 13, stopTypeId: 3, referenceNumber: "Chấm Công - Ra",
        jobLabels: [{ label: "check_out" }], activityCompletedTs: `${DAY} 17:05:00` }),
]), DAY);
check("chấm công does not become a paid job", withChamCong.jobs.length === 1, String(withChamCong.jobs.length));
check("it becomes two punches", withChamCong.punches.length === 2);
check("pointing the right ways",
  withChamCong.punches[0].kind === "in" && withChamCong.punches[1].kind === "out");
// The archived taps bound payroll's shift like any tap would (no trips given here,
// so the check-out closes it).
const bound = workedMinutes(withChamCong.punches, facts([["07:00", "17:00"]], null, null));
check("and the taps bound the shift 07:55–17:05", bound.minutes === 550, String(bound.minutes));

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

console.log("\n6. Eligibility: return runs never, via runs only with a batch");
{
  type Labels = TimelineStop["jobLabels"];
  const RET = [{ labelId: 739, label: "🛵 Vận chuyển mẫu PSC (về)" }] as unknown as Labels;
  const VIA = [{ labelId: 743, label: "🛵 Vận chuyển mẫu PSC (ghé)" }] as unknown as Labels;
  const pair = (id: number, extra: Partial<TimelineStop>) => [
    stop({ jobId: id, stopId: id * 10 + 1, stopTypeId: 1, customerId: `P${id}`, ...extra }),
    stop({ jobId: id, stopId: id * 10 + 2, stopTypeId: 2, ...extra }),
  ];
  const r = payRowsForRoute(route([
    ...pair(21, { jobLabels: RET }),
    ...pair(22, { jobLabels: VIA }),
    ...pair(23, { jobLabels: VIA, itemTrackingNumbers: ["B046260823022509"] }),
    ...pair(24, { jobLabels: ["🛵 Vận chuyển mẫu PSC"] as unknown as Labels }),
    ...pair(25, { jobLabels: VIA, itemTrackingNumbers: [" "] }),
  ]), DAY);
  const ids = r.jobs.map((j) => j.job_id);
  check("return run is not paid", !ids.includes(21));
  check("via run with no batch is not paid", !ids.includes(22) && !ids.includes(25));
  check("via run carrying a batch is paid", ids.includes(23));
  check("outbound run is paid as before", ids.includes(24), JSON.stringify(ids));
}

console.log("\n7. Same trip within 5 minutes at both ends pays once");
{
  const j = (id: number, pick: string, drop: string, o: Record<string, unknown> = {}) => ({
    job_id: id, driver_id: "d1", pickup_customer_id: "D004", dropoff_customer_id: "D001",
    pickup_completed_ts: `${DAY}T${pick}+07:00`, dropoff_completed_ts: `${DAY}T${drop}+07:00`, ...o,
  }) as Parameters<typeof dropSameTripDuplicates>[0][number];
  const ids = (xs: ReturnType<typeof dropSameTripDuplicates>) => xs.map((x) => x.job_id).sort();
  check("exact double-completion keeps the lower id",
    JSON.stringify(ids(dropSameTripDuplicates([j(2, "19:46:52", "20:26:40"), j(1, "19:46:52", "20:26:40")]))) === "[1]");
  check("two batches picked 4 min apart, dropped together → one",
    ids(dropSameTripDuplicates([j(1, "19:46:52", "20:26:40"), j(2, "19:50:50", "20:27:51")])).length === 1);
  check("pickup 6 min apart → two trips",
    ids(dropSameTripDuplicates([j(1, "19:40:00", "20:26:40"), j(2, "19:46:01", "20:26:40")])).length === 2);
  check("drop 6 min apart → two trips",
    ids(dropSameTripDuplicates([j(1, "19:40:00", "20:20:00"), j(2, "19:40:00", "20:26:01")])).length === 2);
  check("different dropoff → two trips",
    ids(dropSameTripDuplicates([j(1, "19:40:00", "20:20:00"), j(2, "19:40:00", "20:20:00", { dropoff_customer_id: "D002" })])).length === 2);
  check("different driver → two trips",
    ids(dropSameTripDuplicates([j(1, "19:40:00", "20:20:00"), j(2, "19:40:00", "20:20:00", { driver_id: "d2" })])).length === 2);
  check("missing stamp is never merged",
    ids(dropSameTripDuplicates([j(1, "19:40:00", "20:20:00"), j(2, "19:40:00", "20:20:00", { pickup_completed_ts: null })])).length === 2);
}

console.log("\n8. Payroll's shift file → shift rows (pay-shifts.ts)");
{
  // Excel hands back a date as days since 1899-12-30 and a time as a day fraction.
  const serial = (Date.UTC(2026, 7, 15) - Date.UTC(1899, 11, 30)) / 86_400_000;
  const grid: unknown[][] = [
    ["Mã nhân viên", "Tài khoản nhân viên", "Họ tên nhân viên", "Ngày làm việc", "Thứ", "Ca vào", "Ca ra"],
    ["PT101235", "P - P - PT101235 Bùi Ngọc Thành", "Bùi Ngọc Thành", serial, 7, 0.5, 20 / 24],
    ["Chưa có code ", "P - P - PTBU Lợi Huỳnh Khoa", "Lợi Huỳnh Khoa", serial, 7, 0.25, 0.5],
    ["PT1", "P - P - PT1 Someone", "Someone", serial, 7, 0.5, 0.25],   // ends before it starts
    [],
  ];
  const p = parsePayrollSheet(grid);
  check("reads the Excel serial date and time fractions",
    p.rows[0]?.date === "2026-08-15" && p.rows[0]?.start === "12:00" && p.rows[0]?.end === "20:00", JSON.stringify(p.rows[0]));
  check("a row with no staff code is kept, code blank", p.rows[1]?.code === "" && p.rows[1]?.account === "P - P - PTBU Lợi Huỳnh Khoa");
  check("an impossible shift is skipped, not stored", p.rows.length === 2 && p.skipped === 1);
  check("columns are found by name, not position",
    parsePayrollSheet([["Ca ra", "Ca vào", "Tài khoản nhân viên", "Ngày làm việc", "Mã nhân viên"], [0.5, 0.25, "A", serial, "PT9"]]).rows[0]?.start === "06:00");
  check("a different file is refused, not half-read", !!parsePayrollSheet([["foo"], [1]]).error);

  const known = [
    { driver_id: "pt", driver_name: "P - P - PT101235 Bùi Ngọc Thành" },
    { driver_id: "khoa", driver_name: "P - P - PTBU Lợi Huỳnh Khoa" },
    { driver_id: "renamed", driver_name: "P - C - PT101999 Tên Mới" },
  ];
  const row = (account: string, code: string) => ({ account, code, date: "2026-08-15", start: "06:00", end: "12:00" });
  check("exact account label matches", resolveDriver(row("P - P - PTBU Lợi Huỳnh Khoa", ""), known) === "khoa");
  check("a renamed account matches on its staff code", resolveDriver(row("P - C - PT101999 Tên Cũ", "PT101999"), known) === "renamed");
  check("no label and no code is left unmatched, never guessed", resolveDriver(row("P - C - PTBU Người Lạ", ""), known) === null);
}

console.log("\n9. Cập nhật công (pay-corrections.ts, and the override in workedMinutes)");
{
  // An approved correction IS the day: it overrides the rule, shift or no shift.
  const fixed = workedMinutes([punch("in", "15:33")], { ...facts([["07:00", "15:00"]], null, null), correction: { start: "07:00", end: "15:41" } });
  check("approved correction replaces the computed window", fixed.minutes === 521 && fixed.corrected, String(fixed.minutes));
  const noShiftFixed = workedMinutes([], { ...facts([], null, null), correction: { start: "19:00", end: "20:30" } });
  check("…even on a day with no shift and no evidence", noShiftFixed.minutes === 90 && !noShiftFixed.no_shift);
  const holidayFixed = workedMinutes([], { ...facts([], null, null, "2026-09-02"), correction: { start: "07:00", end: "08:00" } });
  check("…and still takes the holiday multiplier", holidayFixed.minutes === 180, String(holidayFixed.minutes));

  // Open days: the running period; plus the previous one from the 15th to the 25th.
  const r1 = openRange("2026-10-08");
  check("8/10 → 15/09 to 7/10", r1.from === "2026-09-15" && r1.to === "2026-10-07", JSON.stringify(r1));
  const r2 = openRange("2026-10-20");
  check("20/10 → previous period still open (15/09 on)", r2.from === "2026-09-15", JSON.stringify(r2));
  const r3 = openRange("2026-10-26");
  check("26/10 → only the running period (15/10 on)", r3.from === "2026-10-15", JSON.stringify(r3));
  const r4 = openRange("2026-12-20");
  check("year boundary: 20/12 → 15/11 on", r4.from === "2026-11-15", JSON.stringify(r4));

  const ok = { date: "2026-10-01", in_time: "06:00", out_time: "15:00", note: "" };
  check("a valid request passes", checkTimes(ok, "2026-10-08") === null);
  check("today cannot be corrected", checkTimes({ ...ok, date: "2026-10-08" }, "2026-10-08") !== null);
  check("a closed period cannot, for a driver", checkTimes({ ...ok, date: "2026-09-10" }, "2026-10-08") !== null);
  check("…but can, for a supervisor", checkTimes({ ...ok, date: "2026-09-10" }, "2026-10-08", { anyPastDay: true }) === null);
  check("out must be after in", checkTimes({ ...ok, out_time: "06:00" }, "2026-10-08") !== null);

  const img = { name: "loi.jpg", dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" };
  check("Lỗi hệ thống needs a screenshot", checkProof("system_error", []) !== null);
  check("…and passes with one", checkProof("system_error", [img]) === null);
  check("Quên chấm công needs none", checkProof("forgot_tap", []) === null);
  check("a reason is required", checkProof("", []) !== null);
  check("not an image → refused", checkProof("system_error", [{ name: "x.exe", dataUrl: "data:application/octet-stream;base64,AAAA" }]) !== null);
  check("more than three files → refused", checkProof("forgot_tap", [img, img, img, img]) !== null);
}

console.log(failures === 0 ? "\nAll pay checks passed." : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
