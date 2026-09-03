/**
 * What the late-pickup gate treats as "someone has touched this pickup".
 *
 * Read the header before changing a row. This suite pins INTENDED semantics, and
 * one measurement bounds how much of it is load-bearing: across a real 738-job
 * payload (1,473 stops) a stop's status and its activity stamps move in lockstep —
 * status 1 carries nothing, 2 carries started, 3 carries started+arrived, 4 carries
 * all three — with zero stops carrying arrived or completed while started is null.
 * So on every shape observed so far, reading all three stamps and reading
 * activity_started_ts alone decide identically, and the arrived/completed rows below
 * are guarding a lag Cartrack is documented to have (see isBlockingPickupStop)
 * rather than reproducing a failure anyone has seen.
 *
 * What that lockstep also means, and the reason this file exists at all: a pickup
 * still sitting at status 1 with no stamps is a pickup the driver has not touched
 * IN THE APP. The engine has no other way to know they are standing at the branch,
 * so a driver who arrives without opening the collection stays on this list, and no
 * change to this predicate can rescue that.
 *
 * The rows that MUST keep warning matter more than the ones that must not: this
 * gate is the only thing that tells a supervisor a sample has not been collected,
 * and widening it too far silences that with nothing on screen to say so.
 *
 *   npx tsx scripts/pickup-arrived.test.mts
 */

const { computePickupWarnings } = await import("../src/lib/assign");

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const TODAY = "2026-09-03";
// Fixed clock so the 90-minute grace, the 07:00 floor and the 30-minute
// suppression are all exercised at known offsets rather than at whatever time
// the suite happens to run.
const FAKE_NOW = new Date(`${TODAY}T18:48:00+07:00`).getTime();
Date.now = () => FAKE_NOW;

const DRIVER = "driver-uuid-1";
// Anchored 160 minutes back: past PICKUP_OVERDUE_MIN (90), so an untouched pickup
// warns at +70, and past LATE_ALERT_MIN (120) too.
const ANCHOR = `${TODAY} 16:08:00`;

type Stop = Record<string, unknown>;

/** One open (status 4) client job: clinic pickup, branch dropoff, no plan and no
 *  engine label, so nothing exempts it from the overdue clock. */
const job = (pickup: Stop, jobId = 34437573) => ({
  job_id: jobId,
  job_status_id: 4,
  delivery_driver_id: DRIVER,
  scheduled_delivery_ts: ANCHOR,
  create_ts: ANCHOR,
  labels: [] as string[],
  driver: { first_name: "Trường Công", last_name: "Hồ" },
  stops: [
    { stop_id: 1, stop_type_id: 1, customer_name: "PK Dr Care Implant Clinic", customer_id: "clinic-1", ...pickup },
    { stop_id: 2, stop_type_id: 2, customer_name: "BRA - D029", customer_id: "bra-1", stop_status_id: 1 },
  ],
});

/** A second job for the same driver, used to exercise the two suppressions. */
const otherJob = (stop: Stop, statusId: number) => ({
  job_id: 1,
  job_status_id: statusId,
  delivery_driver_id: DRIVER,
  scheduled_delivery_ts: ANCHOR,
  labels: [] as string[],
  stops: [{ stop_id: 9, stop_type_id: 1, customer_id: "other-1", ...stop }],
});

const untouched: Stop = { stop_status_id: 1 };

// [name, the day's jobs, should the clinic pickup warn]
const cases: [string, unknown[], boolean][] = [
  // ── Must warn: the gate's whole purpose. ──────────────────────────────────
  ["untouched pickup, driver idle — the reason the panel exists", [job(untouched)], true],
  [
    "driver's last completion was 40 min ago — the grace has expired",
    [job(untouched), otherJob({ stop_status_id: 4, activity_completed_ts: `${TODAY} 18:08:00` }, 5)],
    true,
  ],

  // ── Must not warn: the driver has reached this pickup. ────────────────────
  ["arrival stamped, collection not yet open", [job({ stop_status_id: 3, activity_arrived_ts: `${TODAY} 18:41:00` })], false],
  ["arrival stamped while the status still lags at 1", [job({ stop_status_id: 1, activity_arrived_ts: `${TODAY} 18:41:00` })], false],
  ["collection open (activity_started_ts) — the original guard", [job({ stop_status_id: 3, activity_started_ts: `${TODAY} 18:42:00` })], false],
  // Completed well outside the 30-minute grace, so ONLY the completion stamp can
  // suppress this row — the status still reads 2. See isBlockingPickupStop on the lag.
  ["collected at 17:30, but the status still lags at 2", [job({ stop_status_id: 2, activity_completed_ts: `${TODAY} 17:30:00` })], false],
  ["status says completed", [job({ stop_status_id: 4 })], false],
  ["status says rejected", [job({ stop_status_id: 5 })], false],

  // ── Must not warn: the driver is demonstrably occupied elsewhere. ─────────
  [
    "driver has another stop in progress",
    [job(untouched), otherJob({ stop_status_id: 3, activity_started_ts: `${TODAY} 18:30:00` }, 4)],
    false,
  ],
  [
    "driver completed a stop 10 min ago — may still be in transit",
    [job(untouched), otherJob({ stop_status_id: 4, activity_completed_ts: `${TODAY} 18:38:00` }, 5)],
    false,
  ],
];

for (const [name, dayJobs, want] of cases) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const got = computePickupWarnings(dayJobs as any[], TODAY).some((w) => w.job_id === 34437573);
  check(name, got === want, got === want ? "" : `warned=${got}, expected ${want}`);
}

// The badge the supervisor reads: minutes past the 90-minute grace, not raw elapsed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const [w] = computePickupWarnings([job(untouched)] as any[], TODAY);
check(
  "delay is measured past the grace period, not from the anchor",
  w?.minutes_late === 70,
  `minutes_late=${w?.minutes_late}, expected 70`,
);
check("the anchor shown is the job's creation time", w?.create_ts === ANCHOR);

console.log(failures === 0 ? "\nAll arrived-pickup checks passed." : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
