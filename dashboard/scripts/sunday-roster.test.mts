/**
 * The Sunday roster's pure rules: which Sunday an edit is for, how areas match
 * (case and spacing never count — the sheet's SEARCH ignored case, and live
 * rosters spell "Bình chánh" where the rules spell "Bình Chánh"), and what a
 * save refuses.
 *
 *   npx tsx scripts/sunday-roster.test.mts
 */
import assert from "node:assert/strict";
import { areaKey, isSunday, parseRosterLines, rosterGaps, rosterSunday } from "../src/lib/sunday-roster";

const ID = "8094d712-0f78-11f0-b96d-506b8d982279";

// Saturday → tomorrow; Sunday → itself; Monday → six days on.
assert.equal(rosterSunday("2026-10-10"), "2026-10-11");
assert.equal(rosterSunday("2026-10-11"), "2026-10-11");
assert.equal(rosterSunday("2026-10-12"), "2026-10-18");
assert.ok(isSunday("2026-10-11"));
assert.ok(!isSunday("2026-10-10"));
assert.ok(!isSunday("2026-02-31"));

assert.equal(areaKey("  Phòng khám Q7 | Q8 | Bình chánh  "), areaKey("Phòng khám Q7 |  Q8 | Bình Chánh"));

// A clean week passes and is trimmed; an unresolved typed name is kept only
// while no driver is picked.
const ok = parseRosterLines([
  { area: " D001 ca 1 ", driver_id: ID, raw_name: "old", shift: "6:00 - 15:00", note: "" },
  { area: "D043", driver_id: null, raw_name: "Ai đó", shift: "", note: " x " },
]);
assert.deepEqual(ok[0], { area: "D001 ca 1", driver_id: ID, raw_name: null, shift: "6:00 - 15:00", note: "" });
assert.deepEqual(ok[1], { area: "D043", driver_id: null, raw_name: "Ai đó", shift: "", note: "x" });

assert.throws(() => parseRosterLines([{ area: "", driver_id: null }]), /khu vực/);
assert.throws(() => parseRosterLines([{ area: "D001", driver_id: "#N/A" }]), /tài xế/);
assert.throws(() => parseRosterLines([{ area: "D001", driver_id: null, shift: "sáng" }]), /06:00 - 15:00/);
// The same person twice on one area, however the area is spelled.
assert.throws(() => parseRosterLines([{ area: "D001 ca 1", driver_id: ID }, { area: "d001  CA 1", driver_id: ID }]), /Dòng 2/);
// Same person on two areas is normal (ca 2 and ca 3 of one PSC).
assert.equal(parseRosterLines([{ area: "D001 ca 2", driver_id: ID }, { area: "D001 ca 3", driver_id: ID }]).length, 2);

// An area rules depend on with nobody (or only an empty slot) on it is uncovered;
// a line on an area no rule names is flagged as unused.
const gaps = rosterGaps(
  [{ area: "D043", driver_id: null, raw_name: null, shift: "", note: "" },
   { area: "D006 ca 1", driver_id: ID, raw_name: null, shift: "", note: "" },
   { area: "phòng khám q2", driver_id: ID, raw_name: null, shift: "", note: "" }],
  [{ area: "D043", rules: 12 }, { area: "Phòng khám Q2", rules: 3 }, { area: "D006 ca 1", rules: 0 }],
);
assert.deepEqual(gaps.uncovered.map((a) => a.area), ["D043"]);
assert.deepEqual([...gaps.unused], ["d006 ca 1"]);

console.log("sunday-roster: ok");
