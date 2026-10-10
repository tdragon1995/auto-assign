/**
 * A pickup booked for later in the day must not block the branch's request now.
 *   cd dashboard && npx tsx scripts/far-window-pickup.test.mts
 */
import assert from "node:assert/strict";
import { isFarWindowPickup } from "../src/lib/job-filters";

const at = (hhmm: string) => ({ delivery_windows: [{ time_from: `${hhmm}:00+07` }] });
const NOW = 6 * 60 + 37; // 06:37, when D003 was being refused

assert.equal(isFarWindowPickup(at("17:30"), NOW), true, "a 17:30 slot does not block at 06:37");
assert.equal(isFarWindowPickup(at("07:37"), NOW), false, "exactly an hour away still blocks");
assert.equal(isFarWindowPickup(at("07:38"), NOW), true, "61 minutes away does not");
assert.equal(isFarWindowPickup(at("05:00"), NOW), false, "an overdue slot is due, it blocks");
assert.equal(isFarWindowPickup({}, NOW), false, "no window = an ASAP trip, it blocks");
assert.equal(isFarWindowPickup({ delivery_windows: [{ time_from: "17:30:00+07:00" }] }, NOW), true, "REST format");
console.log("far-window-pickup: ok");
