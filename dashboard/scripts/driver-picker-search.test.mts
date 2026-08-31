/**
 * Pins that the driver search finds a name typed without accents.
 *
 * "quynh" must find "Nguyễn Hữu Quỳnh". Without folding, the search silently
 * returns nothing and the picker looks broken rather than picky — which is
 * exactly how it read when the new config rows were first tried on production.
 *
 *   npx tsx scripts/driver-picker-search.test.mts
 */
let failed = 0;
function ok(label: string, cond: boolean) {
  if (cond) return console.log(`  ok   ${label}`);
  failed++;
  console.log(`  FAIL ${label}`);
}

// The predicate as the component applies it.
const fold = (v: string) =>
  v.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
const matches = (name: string, id: string, q: string) =>
  fold(name).includes(fold(q)) || id.toLowerCase().includes(q.toLowerCase());

const QUYNH = "F - C - DC101201 Nguyễn Hữu Quỳnh";
const DOAN  = "P - P - PT101225 Đoàn Văn Thảo";

ok("typed without accents", matches(QUYNH, "id1", "quynh"));
ok("typed with accents", matches(QUYNH, "id1", "Quỳnh"));
ok("partial, no accents", matches(QUYNH, "id1", "huu qu"));
ok("mixed case", matches(QUYNH, "id1", "QuYnH"));
ok("đ typed as d", matches(DOAN, "id2", "doan"));
ok("Đ typed as D", matches(DOAN, "id2", "Doan van"));
ok("đ typed properly still works", matches(DOAN, "id2", "Đoàn"));
ok("the staff code still finds it", matches(QUYNH, "id1", "DC101201"));
ok("the driver id still finds it", matches(QUYNH, "abc-123", "abc-123"));
ok("someone else is not matched", !matches(QUYNH, "id1", "thao"));
ok("an empty search matches everything", matches(QUYNH, "id1", ""));

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
