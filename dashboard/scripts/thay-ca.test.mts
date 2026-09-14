import assert from "node:assert/strict";
import { deriveThayCaRows, encodeThayCaNote, parseThayCaNote } from "../src/lib/thay-ca";
import type { Mapping } from "../src/lib/types";

const mapping = (driver_id: string, start: string, end: string, customer_id = `branch-${driver_id}`): Mapping => ({
  customer_id,
  driver_id,
  smart_driver_id: [],
  dropoff_id: "",
  first_name_last_name: driver_id,
  shift_start: { hours: Number(start.slice(0, 2)), minutes: Number(start.slice(3)) },
  shift_end: { hours: Number(end.slice(0, 2)), minutes: Number(end.slice(3)) },
  bot_token: "", chat_id: "", alt_drop_off_id: "",
});

const base = {
  driver_id: "a", driver_name: "Driver A", leave_from: "2026-09-10", leave_to: "2026-09-10",
  gio_bat_dau: "08:00", gio_ket_thuc: "12:00", loai_nghi: "Nghỉ nguyên buổi",
  subs: [{ id: "b", name: "Driver B", from: null, to: null }],
};

const rows = deriveThayCaRows([base], [mapping("b", "10:00", "14:00")]);
assert.equal(rows.length, 1);
assert.equal(rows[0].leave_from_hr, "10:00");
assert.equal(rows[0].leave_to_hr, "12:00");
assert.equal(rows[0].driver_id, "b");

assert.equal(deriveThayCaRows([base], [mapping("b", "12:00", "14:00")]).length, 0);
assert.equal(deriveThayCaRows([base], [mapping("b", "13:00", "14:00")]).length, 0);

const sourceAndSub = {
  ...base, driver_id: "a", gio_bat_dau: null, gio_ket_thuc: null,
  subs: [{ id: "b", name: "Driver B", from: null, to: null }],
};
assert.equal(
  deriveThayCaRows([sourceAndSub], [
    mapping("a", "16:45", "20:30", "route-1"),
    mapping("b", "07:00", "16:45", "route-1"),
  ]).length,
  0,
  "same-route touching shifts do not create a transfer",
);
const sameRouteOverlap = deriveThayCaRows([sourceAndSub], [
  mapping("a", "16:00", "20:30", "route-1"),
  mapping("b", "07:00", "17:00", "route-1"),
]);
assert.deepEqual(sameRouteOverlap.map((row) => [row.leave_from_hr, row.leave_to_hr]), [["16:00", "17:00"]]);

const separated = deriveThayCaRows(
  [{ ...base, gio_bat_dau: null, gio_ket_thuc: null, subs: [{ id: "b", name: "Driver B", from: "08:00", to: "18:00" }] }],
  [mapping("b", "08:00", "10:00"), mapping("b", "14:00", "16:00")],
);
assert.deepEqual(separated.map((row) => [row.leave_from_hr, row.leave_to_hr]), [["08:00", "10:00"], ["14:00", "16:00"]]);

const smart = (pool: string[], start: string, end: string, customer_id = "pool"): Mapping =>
  ({ ...mapping("", start, end, customer_id), smart_driver_id: pool });
assert.deepEqual(
  deriveThayCaRows([base], [smart(["b", "c"], "10:00", "14:00")]).map((row) => [row.driver_id, row.leave_from_hr, row.leave_to_hr]),
  [["b", "10:00", "12:00"]],
  "a smart pool the sub belongs to is duty too",
);
assert.equal(
  deriveThayCaRows([base], [smart(["a", "b"], "08:00", "12:00")]).length,
  0,
  "a pool shared with the source is not extra work",
);
assert.deepEqual(
  deriveThayCaRows([sourceAndSub], [
    mapping("a", "08:00", "12:00", "route-1"),
    smart(["b", "c"], "11:00", "14:00", "route-1"),
  ]).map((row) => [row.leave_from_hr, row.leave_to_hr]),
  [["11:00", "12:00"]],
  "a fixed source still matches the sub's smart row on the same route",
);

// Live case 14/09: Lợi fixed on BRA-D009 14:45–19:45, full day off, Phương PT
// covers 15:00–20:00 while fixed on unrelated clinic routes 16:45–20:30.
assert.deepEqual(
  deriveThayCaRows(
    [{ ...sourceAndSub, subs: [{ id: "b", name: "Driver B", from: "15:00", to: "20:00" }] }],
    [mapping("a", "14:45", "19:45", "bra-d009"), mapping("b", "16:45", "20:30", "clinic-1"), mapping("b", "16:45", "20:30", "clinic-2")],
  ).map((row) => [row.driver_id, row.leave_from_hr, row.leave_to_hr]),
  [["b", "16:45", "19:45"]],
  "a sub busy on a different route still needs cover",
);

const chain = deriveThayCaRows(
  [{ ...base, note: encodeThayCaNote({
    recordKey: "thay|root|b|0", logicalKey: "thay|root|b", parentKey: "root",
    sourceDriverId: "a", sourceDate: base.leave_from, sourceSubId: "b", chain: ["a", "b"], interval: 0,
  }), driver_id: "b", driver_name: "Driver B", subs: [{ id: "a", name: "Driver A", from: null, to: null }] }],
  [mapping("a", "08:00", "12:00")],
);
assert.equal(chain.length, 0, "reciprocal assignment stops the chain");
assert.deepEqual(parseThayCaNote(rows[0].note)?.chain, ["a", "b"]);

console.log("Thay ca: strict overlap, separated shifts, reciprocal guard and stable metadata passed.");
