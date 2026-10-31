/**
 * Normalising a typed driver name.
 *
 *   npx tsx scripts/driver-match.test.mts
 */
const { normalizeDriverName } = await import("../src/lib/driver-match");

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (label: string, got: string, want: string) =>
  check(label, got === want, `got "${got}", want "${want}"`);

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

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
