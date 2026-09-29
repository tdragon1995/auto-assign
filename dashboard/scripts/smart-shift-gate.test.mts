import assert from "node:assert/strict";
import { waitForMappingShift } from "../src/lib/fixed-driver";
import type { Mapping } from "../src/lib/types";

const mapping = {
  shift_start: { hours: 18, minutes: 45 },
  shift_end: { hours: 21, minutes: 0 },
} as Mapping;
const at = (time: string) => new Date(`2026-09-29T${time}:00+07:00`);

assert.equal(waitForMappingShift(mapping, at("19:00"), at("18:01")), true);
assert.equal(waitForMappingShift(mapping, at("19:00"), at("18:46")), false);
console.log("SMART waits for the selected CONFIG shift before assigning");
