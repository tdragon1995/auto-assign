/**
 * Trimming Cartrack record names down to what a person reads.
 *
 * Both rules chop a prefix off a string, which is the kind of thing that works on
 * every example you thought of and quietly mangles the one you did not. The
 * relief drivers are the case that already got through: the old rule matched
 * `(PT|DC)\d+` and `DCBU` has no digits, so those drivers saw their staff code on
 * screen while everyone else saw a name.
 *
 *   npx tsx scripts/display-names.test.mts
 */
const { driverDisplayName, staffCode, placeName } = await import("../src/lib/display-names");

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (label: string, got: string, want: string) => check(label, got === want, `got "${got}", want "${want}"`);

// ── Driver names ────────────────────────────────────────────────────────────
eq("full-time code is stripped", driverDisplayName("F - C - DC100320 Lý Chánh Hùng"), "Lý Chánh Hùng");
eq("part-time code is stripped", driverDisplayName("P - P - PT101147 Nguyễn Hồng Sơn"), "Nguyễn Hồng Sơn");

// The bug this file exists for. BU = relief driver; the code carries no digits.
eq("DCBU relief driver", driverDisplayName("F - C - DCBU Nguyễn Tuấn Hoàng"), "Nguyễn Tuấn Hoàng");
eq("PTBU relief driver", driverDisplayName("P - P - PTBU Lê Nhật Minh"), "Lê Nhật Minh");
eq("the 3PL proxy account", driverDisplayName("DC100XXX Proxy 3PL Express (Grab) Driver"),
  "Proxy 3PL Express (Grab) Driver");

// No code at all — leave it alone rather than guess.
eq("a name with no staff code is untouched", driverDisplayName("Admin Lý Thị Thùy Linh"), "Admin Lý Thị Thùy Linh");
eq("a bare personal name is untouched", driverDisplayName("Nguyễn Thành Long"), "Nguyễn Thành Long");
eq("empty in, empty out", driverDisplayName(null), "");

// Case sensitivity is load-bearing: a lower-case "pt"/"dc" inside a Vietnamese
// name must never be read as a staff code and eat the name.
eq("lower-case letters are not a staff code", driverDisplayName("Nguyễn Đức Thịnh"), "Nguyễn Đức Thịnh");
check("nothing is ever trimmed to nothing",
  ["F - C - DC100320", "PT101147", "DCBU"].every((n) => driverDisplayName(n) !== ""));

// ── Staff codes ─────────────────────────────────────────────────────────────
// Needed because ~12 drivers hold BOTH accounts under one personal name.
eq("code is recovered", staffCode("F - C - DC100320 Lý Chánh Hùng"), "DC100320");
eq("relief code is recovered", staffCode("P - P - PTBU Lê Nhật Minh"), "PTBU");
eq("no code, no string", staffCode("Admin Lý Thị Thùy Linh"), "");
{
  const a = "P - C - PT101147 Nguyễn Hồng Sơn";
  const b = "F - C - DC100993 Nguyễn Hồng Sơn";
  check("the same person's two accounts are told apart by code, not name",
    driverDisplayName(a) === driverDisplayName(b) && staffCode(a) !== staffCode(b));
}

// ── Place names ─────────────────────────────────────────────────────────────
eq("branch", placeName("BRA - D001"), "D001");
eq("sendout path keeps only the destination", placeName("SENDOUT2 - D10 - HHao - MEDIC"), "MEDIC");
eq("client path keeps the client", placeName("42460373 - D2 - LDCua - Victoria Y Tế Phát Triển"),
  "Victoria Y Tế Phát Triển");
eq("a plain name is untouched", placeName("Bệnh viện Chợ Rẫy"), "Bệnh viện Chợ Rẫy");
eq("empty in, empty out", placeName(null), "");

// Only a SPACED hyphen separates path segments. An unspaced one belongs to the
// name and must survive.
eq("an unspaced hyphen is part of the name", placeName("BRA - Thủ Dầu Một-Bình Dương"), "Thủ Dầu Một-Bình Dương");

console.log(failures === 0 ? "\nAll display-name checks passed." : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
