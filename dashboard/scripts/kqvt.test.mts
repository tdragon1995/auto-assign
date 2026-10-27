/**
 * KQ/VT hand-over rules, offline. Run: npx tsx scripts/kqvt.test.mts
 *
 * Which pickup the hand-over hangs on, when a waiting item is raised, who goes first
 * in a smart ranking, and who collects for a smart client.
 */
import assert from "node:assert/strict";
import { bookedStatus, cancelBlock, chainFrom, deliverTodo, directVerdict, isNear, collectVerdict, handoverTarget, itemsText, legTodos, legVerdict, nearest, planDelivery, rankWithHolderFirst, rideFor, waitingTooLong, WAIT_ALERT_MS, type KqvtEntry } from "../src/lib/kqvt";
import { returnRideable } from "../src/lib/return-trips";
import { PSC_DELIVERY_LABEL, PSC_RETURN_LABEL } from "../src/lib/job-filters";
import type { Job, Mapping } from "../src/lib/types";

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
// A collect job deleted (404) or cancelled drops its item; done by a driver = collected;
// unreadable, not found today, or still waiting → keep waiting. (34497484 was cancelled
// on 19/10 and sat until the 24h row, because cancelled jobs are on no daily list.)
const one = (status: number, driver: string | null, stop: number) =>
  ({ job_status_id: status, delivery_driver_id: driver, stops: [{ stop_status_id: stop }] }) as unknown as Job;
assert.equal(collectVerdict("gone"), "drop");
assert.equal(collectVerdict(one(7, null, 1)), "drop");
assert.equal(collectVerdict(one(5, "H", 4)), "collected");
assert.equal(collectVerdict(one(4, "H", 2)), "wait");
assert.equal(collectVerdict(one(2, null, 1)), "wait");
assert.equal(collectVerdict(null), "wait");
assert.equal(collectVerdict(undefined), "wait");

// Repeats counted, order kept.
const it = (text: string) => ({ text, note: "", links: [] });
assert.equal(itemsText([it("📄 Kết quả"), it("📄 Kết quả")]), "📄 Kết quả ×2");
assert.equal(itemsText([it("📦 Vật tư"), it("📄 Kết quả"), it("📦 Vật tư")]), "📦 Vật tư ×2 + 📄 Kết quả");
// Multi-leg: trace back from the client's default drop-off along the PSC routes.
const D001 = "3927b076-3af9-11ed-b939-506b8dbc8dfb", D002 = "7bc36d6c-3d6a-11ed-a1ac-506b8dbc8dfb";
const D007 = "debfa9a0-3d81-11ed-9ba7-506b8dbc8dfb", D014 = "c79d5fa2-3d85-11ed-a6db-506b8dbc8dfb";
assert.deepEqual(chainFrom(D014), [D014, D007, D001]);
assert.deepEqual(chainFrom(D001), [D001]);
// Plain case: booked where the client drops → auto-assigned there.
assert.deepEqual(planDelivery(D002, D002), { collectAt: D002, hops: [], autoAssign: true });
// D001 clients — and those with no drop-off, which means D001 — are never auto-assigned.
assert.deepEqual(planDelivery(D001, D001), { collectAt: D001, hops: [], autoAssign: false });
assert.deepEqual(planDelivery(D002, D001), { collectAt: D002, hops: [], autoAssign: false });
assert.deepEqual(planDelivery(D001, null), { collectAt: D001, hops: [], autoAssign: false });
assert.deepEqual(planDelivery(D002, null), { collectAt: D002, hops: [], autoAssign: false });
// On the chain → ride the returns down it; collect job waits at the drop-off.
assert.deepEqual(planDelivery(D001, D014), { collectAt: D014, hops: [D007, D014], autoAssign: false });
assert.deepEqual(planDelivery(D007, D014), { collectAt: D014, hops: [D014], autoAssign: false });
// Off the chain (no return runs D007 → D002) → collect at the booking PSC, unassigned.
assert.deepEqual(planDelivery(D007, D002), { collectAt: D007, hops: [], autoAssign: false });

const moving: KqvtEntry = { ...entry, holder: undefined, psc: D014, at: D001, hops: [D007, D014] };
assert.match(legTodos(moving).pickup, /mang về D007/);
assert.match(legTodos(moving).dropoff, /tại D007 \(chuyển tiếp D014\)/);
const ret = (id: number, from: string, to: string, pick: number, extra: Partial<Job> = {}) => ({
  job_id: id, job_status_id: 4, delivery_driver_id: "R", labels: [PSC_RETURN_LABEL],
  stops: [{ stop_type_id: 1, customer_id: from, stop_status_id: pick }, { stop_type_id: 2, customer_id: to, stop_status_id: 1 }],
  ...extra,
}) as unknown as Job;
const yes = () => true;
// The not-started return from where the items are to the next hop — nothing else.
assert.equal(rideFor(moving, [ret(1, D001, D002, 1), ret(2, D001, D007, 4), ret(3, D001, D007, 1)], yes)?.job_id, 3);
assert.equal(rideFor(moving, [ret(4, D001, D007, 1, { labels: [] })], yes), null);
assert.equal(rideFor(moving, [ret(5, D001, D007, 1)], () => false), null);
// Following the carrying return.
assert.equal(legVerdict({ job_status_id: 5, delivery_driver_id: "R", stops: [{ stop_type_id: 2, customer_id: D007, stop_status_id: 4 }] } as unknown as Job, D007), "arrived");
assert.equal(legVerdict(ret(6, D001, D007, 4), D007), "wait");
assert.equal(legVerdict(ret(7, D001, D007, 1, { job_status_id: 7 }), D007), "lost");
assert.equal(legVerdict("gone", D007), "lost");
assert.equal(legVerdict(null, D007), "wait");

// Not the end-of-shift ride: due off within 30 min, or off shift, → no ride.
const at = (h: number, m: number) => new Date(Date.UTC(2026, 9, 25, h - 7, m));
const shift = (s: number, e: number) => ({ shift_start: { hours: s, minutes: 0 }, shift_end: { hours: e, minutes: 0 } }) as unknown as Mapping;
assert.equal(returnRideable([shift(7, 17)], at(16, 0)), true);
assert.equal(returnRideable([shift(7, 17)], at(16, 31)), false);
assert.equal(returnRideable([shift(7, 17)], at(18, 0)), false);
assert.equal(returnRideable([shift(7, 17), shift(16, 22)], at(16, 45)), true);
assert.equal(returnRideable([], at(23, 0)), true);
// What the PSC sees on /qr: its ending first, else where the item is on the list.
const tagged = (x: Partial<KqvtEntry>): KqvtEntry => ({ ...entry, holder: undefined, items: [{ text: "📄 Kết quả", note: "", links: [], bid: "b1" }], ...x });
assert.equal(bookedStatus("b1", { state: "giao", job: 9 }, []).tone, "done");
assert.equal(bookedStatus("b1", { state: "huy" }, []).status, "Chuyến lấy đã bị huỷ");
assert.equal(bookedStatus("b1", null, []).status, "Đang cập nhật");
assert.equal(bookedStatus("b1", null, [tagged({ job_id: 5, collector_name: "An" })]).status, "Chờ An lấy tại D030");
assert.equal(bookedStatus("b1", null, [tagged({ job_id: 5, holder: "H", holder_name: "An" })]).tone, "move");
assert.deepEqual(bookedStatus("b1", null, [tagged({ job_id: -1, at: D001, hops: [D007, D014] })]), { status: "Chờ chuyến về D007 tại D001", tone: "wait", job: null });
assert.deepEqual(bookedStatus("b1", null, [tagged({ job_id: -1, at: D001, hops: [D007, D014], leg_job: 77 })]), { status: "Đang trên chuyến về D007", tone: "move", job: 77 });
assert.equal(bookedStatus("b2", null, [tagged({ job_id: 5 })]).status, "Đang cập nhật");
assert.equal(bookedStatus("b1", { state: "psc" }, []).status, "Đã huỷ");
// The PSC may cancel only while nobody has taken the item.
assert.equal(cancelBlock(tagged({ job_id: 5 })), null);
assert.equal(cancelBlock(tagged({ job_id: -1, at: D001, hops: [D007] })), null);
assert.match(cancelBlock(tagged({ job_id: 5, holder: "H" }))!, /đã lấy/);
assert.match(cancelBlock(tagged({ job_id: -1, at: D001, hops: [D007], leg_job: 77 }))!, /chuyến về/);
// Direct jobs (under NEAR_KM): done when the delivery stop is, dropped when cancelled.
const two = (status: number, pick: number, drop: number) =>
  ({ job_status_id: status, delivery_driver_id: "H", stops: [{ stop_type_id: 1, stop_status_id: pick }, { stop_type_id: 2, stop_status_id: drop }] }) as unknown as Job;
assert.equal(directVerdict(two(4, 4, 1)), "wait");   // collected at the PSC, not yet delivered
assert.equal(directVerdict(two(4, 4, 4)), "done");
assert.equal(directVerdict(two(5, 4, 4)), "done");
assert.equal(directVerdict(two(7, 1, 1)), "drop");
assert.equal(directVerdict("gone"), "drop");
assert.equal(directVerdict(null), "wait");
assert.equal(deliverTodo({ text: "📄 Kết quả", note: "gửi chị Lan", links: [] }), "Giao 📄 Kết quả — gửi chị Lan");
assert.match(bookedStatus("b1", null, [tagged({ job_id: 5, direct: true, collector: "A", collector_name: "An" })]).status, /Giao trực tiếp — An, chưa lấy/);
assert.match(bookedStatus("b1", null, [tagged({ job_id: 5, direct: true })]).status, /chờ điều phối/);
assert.deepEqual(bookedStatus("b1", null, [tagged({ job_id: 5, direct: true, collector: "A", collector_name: "An", collected_ms: 1 })]), { status: "An đang giao tận nơi", tone: "move", job: 5 });
assert.deepEqual(bookedStatus("b1", { state: "toi", job: 5, who: "An" }, []), { status: "Đã giao tận nơi — An", tone: "done", job: 5 });
assert.match(cancelBlock(tagged({ job_id: 5, direct: true, collected_ms: 1 }))!, /đã lấy/);
// Far by straight line → no road lookup at all, not near (D001 → D014 is ~30 km).
assert.equal(await isNear({ lat: 10.775, lon: 106.673 }, { lat: 10.979, lon: 106.655 }), false);
assert.equal(await isNear({ lat: 10.775, lon: 106.673 }, null), false);
console.log("kqvt: ok");
