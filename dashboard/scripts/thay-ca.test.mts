import assert from "node:assert/strict";
import { deriveThayCaRows, encodeThayCaNote, parseThayCaNote } from "../src/lib/thay-ca";
import type { Mapping } from "../src/lib/types";

const mapping = (driver_id: string, start: string, end: string): Mapping => ({
  customer_id: `branch-${driver_id}`,
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

const separated = deriveThayCaRows(
  [{ ...base, gio_bat_dau: null, gio_ket_thuc: null, subs: [{ id: "b", name: "Driver B", from: "08:00", to: "18:00" }] }],
  [mapping("b", "08:00", "10:00"), mapping("b", "14:00", "16:00")],
);
assert.deepEqual(separated.map((row) => [row.leave_from_hr, row.leave_to_hr]), [["08:00", "10:00"], ["14:00", "16:00"]]);

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
