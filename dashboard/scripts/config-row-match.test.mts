import assert from "node:assert/strict";
import test from "node:test";
import { findUniqueConfigRow, parseConfigRowSnapshot } from "../src/lib/config-row-match";

const original = { driver: "Nguyễn Hồng Quân", start: "07:00", end: "08:00", dropoff: "" };
const row = (number: number, values = original) => ({ row: number, pickup: "Bệnh viện Thủ Đức", ...values });

test("finds a shifted rule among other shifts for the same pickup", () => {
  const rows = [
    row(40, { ...original, start: "08:00", end: "09:00" }),
    row(41, { ...original, start: "07:00:00" }),
  ];
  assert.deepEqual(findUniqueConfigRow(rows, "Bệnh viện Thủ Đức", original), { row: 41 });
});

test("refuses identical duplicates even if the hinted row still has the same values", () => {
  assert.deepEqual(findUniqueConfigRow([row(40), row(41)], "Bệnh viện Thủ Đức", original), { reason: "ambiguous" });
});

test("refuses a changed or removed rule", () => {
  assert.deepEqual(findUniqueConfigRow([row(40, { ...original, driver: "Tài xế khác" })], "Bệnh viện Thủ Đức", original), { reason: "missing" });
});

test("snapshot requires the complete old rule", () => {
  assert.equal(parseConfigRowSnapshot({ driver: "A", start: "07:00", end: "08:00" }), null);
  assert.deepEqual(parseConfigRowSnapshot(original), original);
});
