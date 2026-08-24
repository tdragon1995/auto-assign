/**
 * Working out which driver a typed name means.
 *
 * This decides whether a leave row whose driver link went blank gets honoured or
 * ignored, so a wrong answer here moves real work onto the wrong person. The
 * rule is "exactly one working driver, or nothing", and these checks exist to
 * keep it that way — especially the ambiguous cases, which are the ones a
 * looser matcher would quietly get wrong.
 *
 *   npx tsx scripts/driver-match.test.mts
 */
const { matchDriverByName, normalizeDriverName } = await import("../src/lib/driver-match");

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (label: string, got: string, want: string) =>
  check(label, got === want, `got "${got}", want "${want}"`);

// A roster shaped like the real one: staff code prefix, Vietnamese names.
const ROSTER = [
  { driver_id: "id-hung",   name: "F - C - DC100320 Lý Chánh Hùng" },
  { driver_id: "id-son-dc", name: "F - C - DC100777 Nguyễn Hồng Sơn" },
  { driver_id: "id-son-pt", name: "P - P - PT101147 Nguyễn Hồng Sơn" },
  { driver_id: "id-thao",   name: "P - P - PT101225 Đoàn Văn Thảo" },
  { driver_id: "id-hoang",  name: "F - C - DCBU Nguyễn Tuấn Hoàng" },
  { driver_id: "id-tan",    name: "F - C - DC100901 Huỳnh Nhật Tân" },
];

// ── Normalising ─────────────────────────────────────────────────────────────
console.log("normalising a name");
eq("staff code and accents go", normalizeDriverName("F - C - DC100320 Lý Chánh Hùng"), "ly chanh hung");
eq("a bare name normalises the same way", normalizeDriverName("Lý Chánh Hùng"), "ly chanh hung");
eq("case is ignored", normalizeDriverName("LÝ CHÁNH HÙNG"), "ly chanh hung");
eq("repeated spaces collapse", normalizeDriverName("Lý   Chánh  Hùng"), "ly chanh hung");
eq("outer spaces go", normalizeDriverName("  Lý Chánh Hùng  "), "ly chanh hung");
eq("nothing in, nothing out", normalizeDriverName(null), "");

// đ is a distinct Vietnamese letter, not a d with a mark: Unicode decomposition
// leaves it alone, so without an explicit rule "Đoàn" and "Doan" never meet.
eq("đ becomes d", normalizeDriverName("Đoàn Văn Thảo"), "doan van thao");
eq("Đ at the start becomes d", normalizeDriverName("ĐOÀN VĂN THẢO"), "doan van thao");

// ── A single clear match ────────────────────────────────────────────────────
console.log("\nexactly one candidate");
{
  const m = matchDriverByName("Lý Chánh Hùng", ROSTER);
  check("a bare name finds its driver", m.status === "unique" && m.driver_id === "id-hung", JSON.stringify(m));
}
{
  const m = matchDriverByName("ly chanh hung", ROSTER);
  check("…without accents too", m.status === "unique" && m.driver_id === "id-hung", JSON.stringify(m));
}
{
  const m = matchDriverByName("Đoàn Văn Thảo", ROSTER);
  check("…and with đ", m.status === "unique" && m.driver_id === "id-thao", JSON.stringify(m));
}
{
  const m = matchDriverByName("Doan Van Thao", ROSTER);
  check("…typed without any accents at all", m.status === "unique" && m.driver_id === "id-thao", JSON.stringify(m));
}
{
  // The whole point of the exercise: the label is stale, the person is not.
  const m = matchDriverByName("F - C - DCBU Nguyen Tuan Hoang", ROSTER);
  check("a relief driver's code-less staff code still resolves",
    m.status === "unique" && m.driver_id === "id-hoang", JSON.stringify(m));
}

// ── The staff code wins, because it survives a rename ───────────────────────
console.log("\nthe staff code is preferred");
{
  // Spelled differently from the roster — only the code can bridge it.
  const m = matchDriverByName("F - C - DC100901 Huynh Nhat Tan (nghi chieu)", ROSTER);
  check("a code matches even when the name around it does not",
    m.status === "unique" && m.driver_id === "id-tan" && m.via === "code", JSON.stringify(m));
}
{
  // Two accounts, same person, same personal name, different codes: the code
  // is what tells them apart, and it does.
  const m = matchDriverByName("P - P - PT101147 Nguyễn Hồng Sơn", ROSTER);
  check("a code separates the two accounts one person holds",
    m.status === "unique" && m.driver_id === "id-son-pt" && m.via === "code", JSON.stringify(m));
}
{
  // A code nobody holds falls through to the name rather than giving up —
  // the code may simply predate the roster.
  const m = matchDriverByName("F - C - DC999999 Lý Chánh Hùng", ROSTER);
  check("an unknown code falls through to the name",
    m.status === "unique" && m.driver_id === "id-hung" && m.via === "name", JSON.stringify(m));
}

// ── Refusing to guess, which is most of the value ───────────────────────────
console.log("\nrefusing to guess");
{
  // ~12 drivers hold both a PT and a DC account under one personal name. A bare
  // name cannot say which the leave is for, and guessing would put a day's work
  // on the wrong account.
  const m = matchDriverByName("Nguyễn Hồng Sơn", ROSTER);
  check("a name held by two accounts is ambiguous", m.status === "ambiguous", JSON.stringify(m));
  check("…and reports how many", m.status === "ambiguous" && m.count === 2, JSON.stringify(m));
}
{
  const m = matchDriverByName("Trần Văn Không Tồn Tại", ROSTER);
  check("a name nobody has matches nothing", m.status === "none", JSON.stringify(m));
}
{
  check("empty matches nothing", matchDriverByName("", ROSTER).status === "none");
  check("blank matches nothing", matchDriverByName("   ", ROSTER).status === "none");
  check("null matches nothing", matchDriverByName(null, ROSTER).status === "none");
}
{
  // A partial name must NOT be treated as a match. Substring matching is how a
  // matcher like this goes wrong quietly.
  const m = matchDriverByName("Hùng", ROSTER);
  check("a first name alone is not a match", m.status === "none", JSON.stringify(m));
}
{
  const m = matchDriverByName("Lý Chánh Hùng Anh", ROSTER);
  check("a longer name is not a match either", m.status === "none", JSON.stringify(m));
}
{
  // The roster passed in is the set of drivers who can actually work. A driver
  // absent from it — because they left, or their account was deactivated — must
  // never be recovered.
  const withoutHung = ROSTER.filter((r) => r.driver_id !== "id-hung");
  const m = matchDriverByName("Lý Chánh Hùng", withoutHung);
  check("a driver who cannot work is never matched", m.status === "none", JSON.stringify(m));
}
{
  check("an empty roster matches nothing", matchDriverByName("Lý Chánh Hùng", []).status === "none");
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
