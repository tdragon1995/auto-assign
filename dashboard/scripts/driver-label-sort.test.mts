/**
 * The order the leave lists are read in.
 *
 * A driver label leads with employment type and area — "F - C - DC100320 Lý
 * Chánh Hùng" — so an unsorted list is ordered by neither the person nor
 * anything else a supervisor is scanning for. It was previously raw sheet order,
 * which on an append-only log means "whenever the row happened to be filed".
 *
 * Two things this pins:
 *
 *   1. ordering is on the PERSON, so a driver's full-time and part-time accounts
 *      land next to each other. That is the closest thing to grouping them that
 *      keeps each row separately actionable, and it matters now that the MISA
 *      sync files a day off against the twin as well — both accounts show up on
 *      the same day, and used to sit at opposite ends of the list;
 *   2. it is compared in the `vi` locale. Vietnamese orders vowels with their
 *      diacritics; a default code-point comparison files every accented name
 *      after "Z", which scatters most of the roster.
 *
 * Pure string work:
 *
 *   npx tsx scripts/driver-label-sort.test.mts
 */

import {
  splitDriverName, compareDriverNames, compareByDriverThenWindow,
} from "../src/lib/driver-label";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (label: string, got: unknown, want: unknown) =>
  check(label, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── Reading a label ─────────────────────────────────────────────────────────
console.log("splitting a label");
eq("code and person come apart",
  splitDriverName("F - C - DC100320 Lý Chánh Hùng"),
  { code: "F - C - DC100320", name: "Lý Chánh Hùng" });
eq("the part-time account of the same person",
  splitDriverName("P - P - PT101147 Nguyễn Hồng Sơn"),
  { code: "P - P - PT101147", name: "Nguyễn Hồng Sơn" });
eq("a label off the pattern is left whole",
  splitDriverName("Admin Lý Thị Thùy Linh"),
  { code: null, name: "Admin Lý Thị Thùy Linh" });
eq("and so is an empty one", splitDriverName(""), { code: null, name: "" });

// ── Ordering by the person ──────────────────────────────────────────────────
console.log("ordering by the person, not the label");
{
  // Every one of these leads with a different type/area prefix, which is exactly
  // what a naive sort would order them by.
  const labels = [
    "P - P - PT101225 Đoàn Văn Thảo",
    "F - C - DC100777 Nguyễn Hồng Sơn",
    "F - B - DC100901 Huỳnh Nhật Tân",
    "P - P - PT101147 Nguyễn Hồng Sơn",
    "F - C - DC100320 Lý Chánh Hùng",
  ];
  const sorted = [...labels].sort(compareDriverNames).map((l) => splitDriverName(l).name);
  eq("sorted by personal name",
    sorted,
    ["Đoàn Văn Thảo", "Huỳnh Nhật Tân", "Lý Chánh Hùng", "Nguyễn Hồng Sơn", "Nguyễn Hồng Sơn"]);

  const codes = [...labels].sort(compareDriverNames).map((l) => splitDriverName(l).code);
  check("the two accounts of one person are ADJACENT",
    codes[3] === "F - C - DC100777" && codes[4] === "P - P - PT101147",
    `got ${codes[3]} then ${codes[4]}`);
}
check("a tie on the name is broken by the account, not left to chance",
  compareDriverNames("F - C - DC100777 Nguyễn Hồng Sơn", "P - P - PT101147 Nguyễn Hồng Sơn") < 0);
check("…and that ordering is stable when reversed",
  compareDriverNames("P - P - PT101147 Nguyễn Hồng Sơn", "F - C - DC100777 Nguyễn Hồng Sơn") > 0);
check("the same label compares equal to itself",
  compareDriverNames("F - C - DC100320 Lý Chánh Hùng", "F - C - DC100320 Lý Chánh Hùng") === 0);

// ── Vietnamese collation ────────────────────────────────────────────────────
console.log("ordering Vietnamese names");
{
  // "Đ" is a distinct letter that belongs right after "D", and every accented
  // vowel belongs with its base letter. A code-point sort puts all of them last.
  const names = ["Vũ", "Đoàn", "Ánh", "Bùi", "Dương"];
  const byVi = [...names].sort((a, b) => a.localeCompare(b, "vi"));
  eq("accents file with their base letter, not after Z", byVi, ["Ánh", "Bùi", "Dương", "Đoàn", "Vũ"]);
  check("which a code-point sort does NOT do",
    JSON.stringify([...names].sort()) !== JSON.stringify(byVi));
}

// ── Person, then window ─────────────────────────────────────────────────────
console.log("one driver's own windows");
{
  const rows = [
    { driver_name: "F - C - DC100777 Nguyễn Hồng Sơn", timeLabel: "15:00–20:00" },
    { driver_name: "F - C - DC100320 Lý Chánh Hùng",   timeLabel: null },
    { driver_name: "F - C - DC100777 Nguyễn Hồng Sơn", timeLabel: "06:00–15:00" },
  ];
  eq("person first, then morning before afternoon",
    [...rows].sort(compareByDriverThenWindow).map((r) => [splitDriverName(r.driver_name).name, r.timeLabel]),
    [["Lý Chánh Hùng", null], ["Nguyễn Hồng Sơn", "06:00–15:00"], ["Nguyễn Hồng Sơn", "15:00–20:00"]]);
  check("a full day sorts ahead of a windowed row for the same person",
    compareByDriverThenWindow(
      { driver_name: "F - C - DC100777 A", timeLabel: null },
      { driver_name: "F - C - DC100777 A", timeLabel: "06:00–15:00" }) < 0);
}

console.log(failures === 0 ? "\nAll driver-label sort checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
