import assert from "node:assert/strict";
import { createDutyLeave } from "../src/lib/create-duty-leave";
import { subDutyConflicts } from "../src/lib/sub-duty";
import type { Mapping } from "../src/lib/types";

const mapping = {
  driver_id: "b", customer_id: "branch", smart_driver_id: [],
  shift_start: { hours: 8, minutes: 0 }, shift_end: { hours: 18, minutes: 0 },
} as unknown as Mapping;
const subs = [{ id: "b", name: "Driver B", from: "13:00", to: "17:00" }];
const [duty] = subDutyConflicts(subs, null, "2026-09-12", [mapping]);
assert.deepEqual(duty, {
  driver_id: "b", name: "Driver B", date: "2026-09-12",
  from: "13:00", to: "17:00", branches: 1,
});
assert.equal(subDutyConflicts(subs, null, "2026-09-12", []).length, 0);
const [inherited] = subDutyConflicts([{ ...subs[0], from: null, to: null }],
  { start: "09:00", end: "12:00" }, duty.date, [mapping]);
assert.equal(inherited.from, "09:00");
assert.equal(inherited.to, "12:00");

const bodies: Record<string, unknown>[] = [];
const request: typeof fetch = async (url, init) => {
  assert.equal(url, "/api/nghi-phep");
  bodies.push(JSON.parse(String(init?.body)));
  return Response.json({ success: true });
};
await createDutyLeave(duty, request);
assert.equal(bodies[0].driver_id, "b");
assert.equal(bodies[0].ngay_bat_dau, "2026-09-12");
assert.equal(bodies[0].loai_nghi, "nua_buoi");
assert.equal(bodies[0].gio_bat_dau, "13:00");
assert.equal(bodies[0].gio_ket_thuc, "17:00");
assert.equal(bodies[0].pt_companion, undefined);
await createDutyLeave({ ...duty, from: null, to: null }, request);
assert.equal(bodies[1].loai_nghi, "nguyen_buoi");
assert.equal(bodies[1].ngay_ket_thuc, duty.date);
assert.equal(bodies[1].gio_bat_dau, undefined);
await assert.rejects(createDutyLeave(duty, async () =>
  Response.json({ error: "Existing leave" }, { status: 409 })), /Existing leave/);
await assert.rejects(createDutyLeave(duty, async () => {
  throw new Error("Connection lost");
}), /Connection lost/);
console.log("Duty cover: conflict windows, displayed dates, payloads and failures passed.");
