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
  employmentOf, EMPLOYMENT_LABEL, EMPLOYMENT_TITLE, displayDriverCell,
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
// The "F - C - " / "P - P - " prefix is routing metadata on the Cartrack record.
// It tells the reader nothing, and it was the widest thing on the row — on a
// phone it pushed the actual content off the edge.
//
// The code this still returns is NOT rendered any more either; the FT/PT chip
// answers "which of this person's two accounts?" in two characters instead of
// eight. It is still parsed because it breaks a tie when one person's two
// accounts sort against each other, and because it is what the name tooltip
// falls back on — so this is live code, not a leftover.
eq("the routing prefix is dropped, the staff code kept",
  splitDriverName("F - C - DC100320 Lý Chánh Hùng"),
  { code: "DC100320", name: "Lý Chánh Hùng" });
eq("the part-time account of the same person",
  splitDriverName("P - P - PT101147 Nguyễn Hồng Sơn"),
  { code: "PT101147", name: "Nguyễn Hồng Sơn" });
eq("a relief driver's code has no digits and still survives",
  splitDriverName("F - C - DCBU Nguyễn Tuấn Hoàng"),
  { code: "DCBU", name: "Nguyễn Tuấn Hoàng" });
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
    codes[3] === "DC100777" && codes[4] === "PT101147",
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

// ── Which kind of account a label names ─────────────────────────────────────
//
// `DC` and `PT` are payroll prefixes that mean nothing to whoever is reading the
// panel, and in this list they are exactly what tells two adjacent rows apart —
// one person, two accounts, both off, and only one of them is who a substitute
// is covering. Getting this wrong labels a working full-timer as part-time.
console.log("classifying an account");
eq("a DC code is full-time", employmentOf("F - C - DC100320 Lý Chánh Hùng"), "full-time");
eq("a PT code is part-time", employmentOf("P - P - PT101147 Nguyễn Hồng Sơn"), "part-time");
// The relief drivers' codes carry no digits at all — an older rule matching
// (PT|DC)\d+ missed every one of them.
eq("a relief full-timer (DCBU) still classifies", employmentOf("F - C - DCBU Nguyễn Tuấn Hoàng"), "full-time");
eq("a relief part-timer (PTBU) too", employmentOf("P - P - PTBU Trần Văn B"), "part-time");
eq("no code means no claim, not a guess", employmentOf("Admin Lý Thị Thùy Linh"), null);
eq("a bare personal name is not classified", employmentOf("Phạm Thế Luật"), null);
eq("nothing in, nothing out", employmentOf(null), null);
// Case matters: staff codes are upper case, and a lower-case "dc"/"pt" inside a
// Vietnamese name must never be read as an employment type.
eq("a lower-case 'pt' inside a name is not a code", employmentOf("Nguyễn Thị pterodactyl"), null);
// Two letters, not two words: the chip shares a row with a name, a leave type,
// an hour window and up to two buttons, and spelled-out Vietnamese pushed that
// past the width of a phone. The long form lives in the tooltip instead.
eq("the chip is short enough to sit on a phone row",
  [EMPLOYMENT_LABEL["full-time"], EMPLOYMENT_LABEL["part-time"]],
  ["FT", "PT"]);
check("…and every one of them is explained somewhere",
  Object.values(EMPLOYMENT_TITLE).every((t) => t.length > 10));
check("the two accounts of one person classify differently — which is the point",
  employmentOf("F - C - DC100777 Nguyễn Hồng Sơn") !== employmentOf("P - P - PT101147 Nguyễn Hồng Sơn"));

// ── Labels embedded in a SENTENCE ───────────────────────────────────────────
//
// Not every driver name reaches the screen as a name element. The engine's
// failure messages ("2 tài xế cùng trực lúc 18:16: …") and the config panel's
// buttons ("Nới … → 05:00–13:25") build a sentence around one, and the component
// cannot reach those — they were still printing the full label long after the
// lists had stopped.
console.log("labels inside a sentence");
eq("a single-name config cell",
  displayDriverCell("F - P - DC100074 Võ Văn Tân"), "Võ Văn Tân");
// A smart row's cell holds several names, comma-separated. Cleaning has to keep
// it a list — the separator is the one the sheet's own id formula splits on.
eq("a smart row's several names stay a list",
  displayDriverCell("F - C - DC100320 Lý Chánh Hùng, P - P - PT101147 Nguyễn Hồng Sơn"),
  "Lý Chánh Hùng, Nguyễn Hồng Sơn");
eq("an empty cell stays empty", displayDriverCell(""), "");
eq("nothing in, nothing out", displayDriverCell(null), "");
eq("a name with no code is left alone",
  displayDriverCell("Admin Lý Thị Thùy Linh"), "Admin Lý Thị Thùy Linh");
eq("stray spacing around the comma does not survive as a name",
  displayDriverCell("F - C - DCBU Nguyễn Tuấn Hoàng ,  P - P - PTBU Trần Văn B"),
  "Nguyễn Tuấn Hoàng, Trần Văn B");

console.log(failures === 0 ? "\nAll driver-label sort checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
