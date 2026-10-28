/**
 * The Sunday roster's pure rules: which Sunday an edit is for, how areas match
 * (case and spacing never count — the sheet's SEARCH ignored case, and live
 * rosters spell "Bình chánh" where the rules spell "Bình Chánh"), and what a
 * save refuses.
 *
 *   npx tsx scripts/sunday-roster.test.mts
 */
import assert from "node:assert/strict";
import { areaKey, averageRoster, isSunday, parseRosterLines, rosterGaps, rosterSunday, sundayDrivers } from "../src/lib/sunday-roster";

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

// A rule's area is found INSIDE a line's area, as the sheet's SEARCH did:
// rule "D004" is covered by the "D004 ca 1" line (20/09 showed it uncovered).
const ID2 = "11111111-2222-4333-8444-555555555555";
const inside = rosterGaps(
  [{ area: "D004 ca 1", driver_id: ID2, raw_name: null, shift: "07:00 - 15:00", note: "" },
   { area: "D021", driver_id: null, raw_name: null, shift: "06:00 - 12:00", note: "" }],
  [{ area: "D004", rules: 1 }, { area: "D004 ca 1", rules: 1 }, { area: "D021", rules: 11 }],
);
assert.deepEqual(inside.uncovered.map((a) => a.area), ["D021"], "a line with no driver still leaves its rules uncovered");

console.log("sunday-roster: ok");

// Who drives a Sunday rule: every line whose area equals one of the rule's
// areas (case/spacing aside), roster order, each driver once. "D004" does not
// match "D004 ca 1" — the sheet's formula never did either.
const A = "11111111-1111-1111-1111-111111111111", B = "22222222-2222-2222-2222-222222222222";
const lines = [
  { area: "D032 ca 2", driver_id: B }, { area: "d032  CA 1", driver_id: A },
  { area: "D032 ca 1", driver_id: null }, { area: "D032 ca 2", driver_id: A }, { area: "D004 ca 1", driver_id: B },
];
assert.deepEqual(sundayDrivers(["D032 ca 1", "D032 ca 2"], lines), [B, A]);
assert.deepEqual(sundayDrivers(["D032 ca 1"], lines), [A]);
assert.deepEqual(sundayDrivers(["D004"], lines), []);
assert.deepEqual(sundayDrivers([], lines), []);

// Suggestions come from same-district clinics only, by exact hours; a clinic
// never suggests to itself, and rules with no area are no evidence.
{
  const { districtOf, suggestSundayArea, suggestSundayDay } = await import("../src/lib/sunday-roster");
  assert.equal(districtOf("20198 - TBinh - PVHai - ThS.BS Lâm Quang An"), "tbinh");
  const r = (customer_id: string, pickup: string, start: string, end: string, areas: string[], alt = "") => ({ customer_id, pickup, start, end, areas, alt_drop_off_id: alt });
  const rows = [
    r("a", "1 - TBinh - X - A", "07:00", "14:00", ["TB ca 1"]), r("a", "1 - TBinh - X - A", "15:00", "16:00", ["TB ca 2"], "P"),
    r("b", "2 - TBinh - Y - B", "07:00", "14:00", ["TB ca 1"]), r("b", "2 - TBinh - Y - B", "15:00", "16:00", ["TB ca 2"], "P"),
    r("c", "3 - TBinh - Z - C", "06:00", "14:00", ["Other"]),
    r("d", "4 - D8 - Z - D", "07:00", "14:00", ["Q8 ca 1"]),
    r("e", "5 - TBinh - Z - E", "07:00", "14:00", []),
  ];
  assert.deepEqual(suggestSundayArea("9 - TBinh - Q - New", "new", "07:00", "14:00", rows), ["TB ca 1"]);
  assert.deepEqual(suggestSundayArea("9 - D8 - Q - New", "new", "07:00", "14:00", rows), ["Q8 ca 1"]);
  assert.equal(suggestSundayArea("9 - D8 - Q - New", "new", "06:00", "14:00", rows), null);
  assert.equal(suggestSundayArea("4 - D8 - Z - D", "d", "07:00", "14:00", rows), null);
  const day = suggestSundayDay("9 - TBinh - Q - New", "new", rows)!;
  assert.deepEqual(day.lines, [
    { start: "07:00", end: "14:00", areas: ["TB ca 1"], alt_drop_off_id: "" },
    { start: "15:00", end: "16:00", areas: ["TB ca 2"], alt_drop_off_id: "P" },
  ]);
  assert.equal(suggestSundayDay("9 - Nowhere - Q - New", "new", rows), null);
}
console.log("sunday suggestions: ok");

// Overlapping Sunday rules share the work instead of clashing.
{
  const { mergeSundayOverlaps } = await import("../src/lib/sunday-roster");
  const t = (s: string) => { const [h, m] = s.split(":").map(Number); return { hours: h, minutes: m }; };
  const row = (start: string, end: string, ids: string[], extra: Record<string, string> = {}) => ({
    customer_id: "D004", dropoff_id: "", alt_drop_off_id: "", first_name_last_name: ids.join(","),
    driver_id: ids.length === 1 ? ids[0] : "", smart_driver_id: ids.length > 1 ? ids : [], shift_start: t(start), shift_end: t(end), ...extra });
  const show = (rs: ReturnType<typeof row>[]) => rs.map((r) => `${r.shift_start!.hours}:${String(r.shift_start!.minutes).padStart(2, "0")}-${r.shift_end!.hours}:${String(r.shift_end!.minutes).padStart(2, "0")} ${r.driver_id || r.smart_driver_id.join("+")}`).sort();
  // D004: ca 2 Long 06–14, ca 1 Quốc 07–14, ca 3 Quốc 14:30–17 → Long alone first, then both, ca 3 untouched.
  assert.deepEqual(show(mergeSundayOverlaps([row("06:00", "14:00", ["L"]), row("07:00", "14:00", ["Q"]), row("14:30", "17:00", ["Q"])])),
    ["14:30-17:00 Q", "6:00-7:00 L", "7:00-14:00 L+Q"]);
  // The same driver twice (the 07:00–08:00 duplicates) collapses back into one fixed rule.
  assert.deepEqual(show(mergeSundayOverlaps([row("07:00", "14:00", ["A"]), row("07:00", "08:00", ["A"])])), ["7:00-14:00 A"]);
  // A smart pool joining a fixed rule: everyone on in the slice.
  assert.deepEqual(show(mergeSundayOverlaps([row("06:00", "12:00", ["A", "B"]), row("10:00", "15:00", ["C"])])),
    ["10:00-12:00 A+B+C", "12:00-15:00 C", "6:00-10:00 A+B"]);
  // Different alternate drop-off: a real question, so left to clash.
  const alt = [row("06:00", "14:00", ["L"]), row("07:00", "14:00", ["Q"], { alt_drop_off_id: "D029" })];
  assert.deepEqual(mergeSundayOverlaps(alt), alt);
  // No overlap: rows come back untouched.
  const clean = [row("06:00", "10:00", ["A"]), row("10:00", "14:00", ["B"])];
  assert.deepEqual(mergeSundayOverlaps(clean), clean);
}
console.log("sunday overlaps: ok");

// Lịch CN mẫu: most Sundays wins, a tie goes to the most recent, shift from
// their latest Sunday there; areas and order follow the newest Sunday.
{
  const A = "a", B = "b", C = "c";
  const line = (area: string, driver_id: string | null, shift = "06:00 - 15:00") => ({ area, driver_id, raw_name: null, shift, note: "" });
  const avg = averageRoster([
    [line("Q1", B, "07:00 - 16:00"), line("Q2", C), line("New", null)],
    [line("q1", B), line("Q2", A), line("Gone", A)],
    [line("Q1", A), line("Q2", A)],
    [line("Q1", A, "05:00 - 14:00"), line("Q2", C)],
  ]);
  assert.deepEqual(avg.map((l) => [l.area, l.driver_id, l.shift]), [
    ["Q1", B, "07:00 - 16:00"], // 2–2 tie: B held it most recently
    ["Q2", C, "06:00 - 15:00"], // 2–2 tie: C is on the newest Sunday
    ["New", null, "06:00 - 15:00"],
  ]);
  assert.equal(averageRoster([[line("Q1", A)], [line("Q1", B)], [line("Q1", B)]])[0].driver_id, B);
  assert.deepEqual(averageRoster([]), []);
}
console.log("averageRoster ok");
