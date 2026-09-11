/**
 * Searching the config table from the dashboard.
 *
 * This is the only search over ~1,700 rows anyone uses to answer "who covers
 * this branch?", and it also feeds the copy-from-another-branch picker — so a
 * miss is not a cosmetic failure: it either sends someone to the workbook, or it
 * hides the branch whose pattern they were about to copy.
 *
 * Two behaviours worth holding:
 *
 *   1. ACCENT FOLDING. "quynh" has to find "Quỳnh". Without it the search reads
 *      as broken rather than picky — the same failure the driver picker had.
 *   2. EVERY TERM, ANY FIELD. "d014 hùng" finds the branch-and-driver pair
 *      without the typist knowing which column each word lives in. Requiring all
 *      terms in ONE field would make the useful queries the failing ones.
 *
 *   npx tsx scripts/config-search.test.mts
 */

import { searchConfigRows } from "../src/components/config-browser-panel";
import { configFilterOptions, EMPTY_CONFIG_FILTERS, filterConfigRows } from "../src/lib/config-filters";
import type { ConfigRowView } from "../src/app/api/config/rows/route";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (label: string, got: unknown, want: unknown) =>
  check(label, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const row = (o: Partial<ConfigRowView>): ConfigRowView => ({
  row: 2, customer_id: "", pickup: "", driver: "", start: "", end: "", dropoff: "", smart: false, ...o,
});

const ROWS: ConfigRowView[] = [
  row({ row: 10, customer_id: "D014", pickup: "BRA - D014 - Quận 1", driver: "F - C - DC100320 Lý Chánh Hùng", start: "05:00", end: "13:25" }),
  row({ row: 11, customer_id: "D014", pickup: "BRA - D014 - Quận 1", driver: "F - C - DC100777 Nguyễn Hồng Sơn", start: "13:25", end: "19:00" }),
  row({ row: 12, customer_id: "D002", pickup: "BRA - D002 - NTrai", driver: "P - P - PT101147 Nguyễn Hữu Quỳnh", start: "07:00", end: "16:00" }),
  row({ row: 13, customer_id: "D037", pickup: "PS315 Nguyễn Thị Định", driver: "", start: "", end: "" }),
  row({ row: 14, customer_id: "D021", pickup: "BRA - D021 - TBinh", driver: "A, B", start: "06:00", end: "18:00", smart: true }),
];

const found = (q: string) => searchConfigRows(ROWS, q).map((r) => r.row);

console.log("finding a row");
eq("an empty query is everything, not nothing", searchConfigRows(ROWS, "").length, ROWS.length);
eq("whitespace alone is also everything", searchConfigRows(ROWS, "   ").length, ROWS.length);
eq("by branch code", found("d014"), [10, 11]);
eq("by place name", found("ntrai"), [12]);
eq("by driver", found("chánh hùng"), [10]);

console.log("folding accents");
eq("a name typed without accents still matches", found("quynh"), [12]);
eq("…and with them", found("Quỳnh"), [12]);
eq("đ is a letter, not a d with a mark", found("dinh"), [13]);
eq("case is ignored", found("LÝ CHÁNH HÙNG"), [10]);

console.log("several terms");
eq("every term must match, but any field may carry it", found("d014 sơn"), [11]);
eq("…so a term matching nothing narrows to nothing", found("d014 quỳnh"), []);
eq("a time is searchable too", found("13:25"), [10, 11]);

console.log("what a match is not");
eq("a branch with no driver is still findable — that IS the to-do", found("PS315"), [13]);
check("a smart row is not hidden", found("d021").length === 1);
eq("nothing matches gibberish", found("zzzz"), []);

// ── A term prefixes a WORD; it is not a substring hunt ───────────────────────
//
// Live report: searching "đa khoa ái nghĩa" returned "Bệnh Viện Đa Khoa Khu Vực
// Củ Chi". Every term hit, and not one of them hit the branch asked for — `da`
// and `khoa` from "Đa Khoa", `nghia` from the DRIVER two columns over, and `ai`
// from inside the staff code "NVHo·ai·". The shorter the term, the more of the
// sheet a substring match drags in.
{
  const CUCHI = row({
    row: 20, customer_id: "17347",
    pickup: "17347 - CChi - NVHoai - Bệnh Viện Đa Khoa Khu Vực Củ Chi",
    driver: "Trần Nguyễn Thanh Duy, Phan Thanh Nghĩa", start: "05:00", end: "15:30",
  });
  const AINGHIA = row({
    row: 21, customer_id: "12702",
    pickup: "12702 - BHoa - DKhoi - PHÒNG KHÁM ĐA KHOA ÁI NGHĨA ĐỒNG KHỞI",
    driver: "Nguyễn Minh Nhật", start: "07:00", end: "16:00",
  });
  const both = [CUCHI, AINGHIA];
  const hits = (q: string) => searchConfigRows(both, q).map((r) => r.row);

  eq("the branch asked for, and only it", hits("đa khoa ái nghĩa"), [21]);
  eq("...typed without accents too", hits("da khoa ai nghia"), [21]);
  eq("a term inside a staff code is not a match", hits("ai"), [21]);

  // The reason a word-START rule and not a whole-word one: the run-together
  // codes are how every row is labelled, and people type the readable half.
  eq("the readable half of a code still finds it", hits("hoai"), [20]);
  eq("...and of another", hits("khoi"), [21]);
  eq("the code itself still finds it", hits("nvhoai"), [20]);
  eq("a prefix of a real word still matches", hits("nguy"), [20, 21]);
  // Cross-field is deliberate and stays.
  eq("branch and driver together", hits("cu chi nghia"), [20]);
}

console.log("dashboard phrase and facet filters");
{
  const HOANG_PHI = "F - C - DC100001 Nguyễn Hoàng Phi";
  const VIET_PHI = "F - C - DC100002 Nguyễn Viết Phi";
  const THANH_AN = "P - P - PT100003 Trần Thanh An";
  const FILTER_ROWS = [
    row({ row: 30, customer_id: "D030", pickup: "Kho Trung Tâm", driver: HOANG_PHI, start: "05:00", end: "13:00", dropoff: "Bệnh viện Quận 1" }),
    row({ row: 31, customer_id: "D031", pickup: "Điểm Hoàng Gia", driver: VIET_PHI, start: "13:00", end: "21:00", dropoff: "Bệnh viện Quận 2" }),
    row({ row: 32, customer_id: "D032", pickup: "Kho Miền Đông", driver: `${VIET_PHI}, ${THANH_AN}`, start: "07:00", end: "16:00", dropoff: "", smart: true }),
    row({ row: 33, customer_id: "D033", pickup: "Kho Miền Tây", driver: THANH_AN, start: "08:00", end: "17:00", dropoff: "Phòng khám An Bình" }),
  ];
  const hits = (partial: Partial<typeof EMPTY_CONFIG_FILTERS>) =>
    filterConfigRows(FILTER_ROWS, { ...EMPTY_CONFIG_FILTERS, ...partial }).map((r) => r.row);

  eq("an empty dashboard filter returns every row", hits({}), [30, 31, 32, 33]);
  eq("a driver phrase finds the right Phi", hits({ query: "Nguyễn Hoàng Phi" }), [30]);
  eq("the same phrase without accents", hits({ query: "nguyen hoang phi" }), [30]);
  eq("extra whitespace is collapsed", hits({ query: "  nguyen   hoang   phi  " }), [30]);
  eq("a name cannot be assembled from pickup and driver", hits({ query: "hoàng phi" }), [30]);
  eq("a phrase cannot span the customer code and driver", hits({ query: "D030 Nguyễn" }), []);
  eq("a phrase cannot span two drivers in a smart row", hits({ query: "Phi Trần" }), []);
  eq("punctuation remains literal", hits({ query: "Nguyễn-Hoàng Phi" }), []);
  eq("displayed shift punctuation remains searchable", hits({ query: "05:00–13:00" }), [30]);

  eq("selected drivers are OR choices", hits({ drivers: [HOANG_PHI, THANH_AN] }), [30, 32, 33]);
  eq("a selected driver matches inside a smart row", hits({ drivers: [VIET_PHI] }), [31, 32]);
  eq("pickup selections are exact OR choices", hits({ pickups: ["Kho Trung Tâm", "Kho Miền Tây"] }), [30, 33]);
  eq("pickup contains is accent-insensitive", hits({ pickupContains: "mien dong" }), [32]);
  eq("drop-off selections are exact", hits({ dropoffs: ["Bệnh viện Quận 2"] }), [31]);
  eq("a selected drop-off excludes all-destination rows", hits({ dropoffs: ["Bệnh viện Quận 2"] }), [31]);
  eq("all destinations is an explicit blank selection", hits({ dropoffs: [""] }), [32]);
  eq("drop-off contains is accent-insensitive", hits({ dropoffContains: "phong kham" }), [33]);
  eq("separate controls combine with AND", hits({ drivers: [VIET_PHI], pickupContains: "miền", dropoffs: [""] }), [32]);

  const options = configFilterOptions(FILTER_ROWS);
  eq("driver options split and deduplicate smart cells", options.drivers.length, 3);
  eq("pickup options are deduplicated", options.pickups.length, 4);
  eq("all destinations is the first drop-off option", options.dropoffs[0], "");
  eq("option ordering is stable", options, configFilterOptions(FILTER_ROWS));
}

console.log(failures === 0 ? "\nAll config-search checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
