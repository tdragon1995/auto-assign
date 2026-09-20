/**
 * Pickup setup: which pickups are measured, when an ETA is proposed, and what
 * counts as Labcenter drifting from the master copy. Offline.
 *
 *   npx tsx scripts/pickup-setup.test.mts
 */
import assert from "node:assert/strict";
import { compareWithLabcenter, etaProposals, pickupEtaRows, roundTo5, targetMins, type SetupRow } from "../src/lib/pickup-setup";
import type { TimelineRoute, TimelineStop } from "../src/lib/types";

// ── 1. Measured pickups ──
// The clock starts when the pickup was DUE, so a job created the day before is
// measured from its scheduled minute rather than from its creation.
const stop = (over: Partial<TimelineStop> & { jobId: number }): TimelineStop => ({
  stopTypeId: 1,
  jobStatusId: 5,
  customerId: "c1",
  customerName: "123 - D1 - Clinic",
  scheduledDeliveryTs: "2026-09-17 09:00:00",
  activityArrivedTs: "2026-09-17 09:40:00",
  activityCompletedTs: "2026-09-17 09:45:00",
  deliveryWindows: [],
  planId: null,
  lastAssignedPlanId: null,
  ...over,
} as unknown as TimelineStop);

const route = (stops: TimelineStop[]): TimelineRoute => ({ orderedStops: stops } as unknown as TimelineRoute);

/** The matching dropoff, which may be worked by a DIFFERENT driver — that is why
 *  the day's dropoffs are collected across every route, not per route. */
const dropoff = (jobId: number, completed: string | null) => ({
  stopTypeId: 2, jobId, activityCompletedTs: completed,
} as unknown as TimelineStop);

const rows = pickupEtaRows([
  route([
    stop({ jobId: 1 }),
    stop({ jobId: 2, lastAssignedPlanId: 9 }),                          // plan slot
    stop({ jobId: 3, customerName: "BRA - D014" }),                     // branch
    stop({ jobId: 4, customerName: "3PL - TLT" }),                      // 3PL
    stop({ jobId: 5, jobStatusId: 4 }),                                 // not finished
    stop({ jobId: 6, stopTypeId: 2 }),                                  // dropoff
    stop({ jobId: 7, scheduledDeliveryTs: "2026-09-16 21:00:00" }),     // parked overnight
    stop({ jobId: 8, activityArrivedTs: null }),                        // falls back to completed
    stop({ jobId: 9, deliveryWindows: [{ stopId: 9, timeFrom: "10:00:00+07", timeTo: "11:00:00+07" }] }), // windowed: kept, flagged
  ]),
  // The same job seen on a second route must not be counted twice.
  route([stop({ jobId: 1 })]),
  // Another driver's route: it carries the deliveries for the day.
  route([
    dropoff(1, "2026-09-17 11:00:00"),
    dropoff(8, "2026-09-17 11:10:00"),
    dropoff(9, "2026-09-17 11:20:00"),
    dropoff(10, "2026-09-18 07:00:00"),  // delivered the NEXT day
    dropoff(11, null),                    // never finished
  ]),
  route([stop({ jobId: 10 }), stop({ jobId: 11 })]),
]);
assert.deepEqual(rows.map((r) => r.job_id), [1, 8, 9, 10, 11]);
// Kept with the day recorded; the view scores only dropoff_date = trip_date.
assert.deepEqual(rows.map((r) => r.dropoff_date), ["2026-09-17", "2026-09-17", "2026-09-17", "2026-09-18", null]);
assert.equal(rows[0].scheduled_ts, "2026-09-17T09:00:00+07:00");
assert.equal(rows[0].arrived_ts, "2026-09-17T09:40:00+07:00");
assert.equal(rows[0].trip_date, "2026-09-17");
assert.equal(rows[1].arrived_basis, "completed");
assert.equal(rows[1].arrived_ts, "2026-09-17T09:45:00+07:00");
assert.equal(rows[2].has_window, true);

// ── 2. Proposals ──
const setup = (id: number, pick: string | null, eta: number): SetupRow => ({
  lc_location_id: id, pick_id: pick, pick_name: `P${id}`, drop_location_id: 560, drop_id: "d", drop_name: "BRA - D003", eta_mins: eta,
});
const st = (id: string, p80: number, median = p80 * 0.6) => ({ pickup_customer_id: id, n: 8, median_mins: median, p80_mins: p80 });
const p = etaProposals(
  [setup(1, "a", 60), setup(2, "b", 60), setup(3, "c", 60), setup(4, null, 60), setup(5, "e", 0), setup(6, "f", 40)],
  [
    st("a", 66),   // exactly 10% → not proposed
    st("b", 80),   // +33% → 80
    st("c", 45.4), // −24% → 45
    st("e", 30),   // blank ETA → always proposed
    st("f", 45.3), // +13%, rounds to 45 ≠ 40 → proposed
  ],
);
assert.deepEqual(p.map((x) => [x.lc_location_id, x.proposed_mins]), [[5, 30], [2, 80], [3, 45], [6, 45]]);

// A bimodal client: served in 32 min four times in five, six hours the rest. The
// promise follows the experience (2 × median), not the raw p80.
const [bimodal] = etaProposals([setup(7, "g", 30)], [st("g", 369, 32)]);
assert.equal(bimodal.proposed_mins, 65);
assert.equal(targetMins(32, 369), 64);
assert.equal(targetMins(298, 421), 421);  // genuinely slow client: no cap applies
assert.equal(targetMins(1, 8), 8);        // cap never RAISES the target above the p80
assert.equal(roundTo5(2), 5);
assert.equal(roundTo5(1000), 480);
assert.equal(roundTo5(62.4), 60);

// ── 3. Drift / adopt / rename ──
const { adopt, drift, renamed } = compareWithLabcenter(
  [setup(1, "a", 60), setup(2, "b", 60), { ...setup(3, "c", 60), pick_name: null }],
  [
    { lc_location_id: 1, pick_name: "P1", drop_location_id: 560, drop_name: "BRA - D003", eta_mins: 60 },     // same
    { lc_location_id: 3, pick_name: "P3 new", drop_location_id: 560, drop_name: "BRA - D003", eta_mins: 60 }, // renamed only
    { lc_location_id: 2, pick_name: "P2", drop_location_id: 548, drop_name: "BRA - D018", eta_mins: 60 },     // drop changed
    { lc_location_id: 9, pick_name: "P9", drop_location_id: 1, drop_name: "BRA - D001", eta_mins: 60 },       // new
  ],
);
assert.deepEqual(adopt.map((a) => a.lc_location_id), [9]);
assert.deepEqual(drift.map((d) => d.lc_location_id), [2]);
assert.deepEqual(renamed.map((r) => [r.lc_location_id, r.pick_name, r.eta_mins]), [[3, "P3 new", 60]]); // name only, setup untouched

console.log("pickup-setup: all assertions passed");
