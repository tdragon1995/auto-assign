/**
 * KQ/VT hand-over rules, offline. Run: npx tsx scripts/kqvt.test.mts
 *
 * Which pickup the hand-over hangs on, when a waiting item is raised, who goes first
 * in a smart ranking, and who collects for a smart client.
 */
import assert from "node:assert/strict";
import { handoverTarget, nearest, rankWithHolderFirst, waitingTooLong, WAIT_ALERT_MS, type KqvtEntry } from "../src/lib/kqvt";
import { PSC_DELIVERY_LABEL } from "../src/lib/job-filters";
import type { Job } from "../src/lib/types";

const entry: KqvtEntry = {
  job_id: 1, psc: "PSC", psc_name: "D030", client_id: "X", client_name: "Khách X",
  items: [{ text: "📄 Kết quả", note: "", links: [] }], created_ms: 0, holder: "H",
};
const job = (id: number, driver: string | null, clientStopStatus: number, extra: Partial<Job> = {}) => ({
  job_id: id, job_status_id: driver ? 4 : 2, delivery_driver_id: driver, labels: [],
  stops: [
    { stop_type_id: 1, customer_id: "X", stop_status_id: clientStopStatus },
    { stop_type_id: 2, customer_id: "PSC", stop_status_id: 1 },
  ],
  ...extra,
}) as unknown as Job;

// The holder's not-started pickup at the client — nobody else's, never a started one.
assert.equal(handoverTarget(entry, [job(10, "B", 1), job(11, "H", 2), job(12, "H", 1)])?.job_id, 12);
assert.equal(handoverTarget(entry, [job(10, "B", 1), job(11, "H", 3)]), null);
// Never the collect job itself, never a cancelled job.
assert.equal(handoverTarget(entry, [job(13, "H", 1, { labels: [PSC_DELIVERY_LABEL] })]), null);
assert.equal(handoverTarget(entry, [job(14, "H", 1, { job_status_id: 7 })]), null);
// No holder yet → nothing to hang.
assert.equal(handoverTarget({ ...entry, holder: undefined }, [job(15, "H", 1)]), null);

// 24h counts from collection once collected, from booking before.
assert.equal(waitingTooLong({ ...entry, holder: undefined, created_ms: 0 }, WAIT_ALERT_MS + 1), true);
assert.equal(waitingTooLong({ ...entry, created_ms: 0, collected_ms: 10 }, WAIT_ALERT_MS + 1), false);

// Holder first, the rest in their order; absent or already first → same array back.
const ranked = ["A", "B", "H", "C"];
assert.deepEqual(rankWithHolderFirst(ranked, "H", (x) => x), ["H", "A", "B", "C"]);
assert.equal(rankWithHolderFirst(ranked, "Z", (x) => x), ranked);
assert.equal(rankWithHolderFirst(["H", "A"], "H", (x) => x)[0], "H");

// Collector for a smart client: a logged-in, not-on-break candidate nearest the PSC.
const live = [
  { deliveryDriverId: "near-break", latitude: 10.0001, longitude: 106, isLoggedIn: true, onBreakSinceTs: "x" },
  { deliveryDriverId: "far", latitude: 10.2, longitude: 106, isLoggedIn: true },
  { deliveryDriverId: "near", latitude: 10.01, longitude: 106, isLoggedIn: true },
  { deliveryDriverId: "not-candidate", latitude: 10, longitude: 106, isLoggedIn: true },
];
assert.equal(nearest(["near-break", "far", "near"], live, 10, 106)?.deliveryDriverId, "near");
assert.equal(nearest(["nobody"], live, 10, 106), null);
console.log("kqvt: ok");
