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

  eq("is matches any selected driver", hits({ driverOperator: "is", drivers: [HOANG_PHI, THANH_AN] }), [30, 32, 33]);
  eq("is matches a driver inside a smart row", hits({ driverOperator: "is", drivers: [VIET_PHI] }), [31, 32]);
  eq("is not excludes every selected driver", hits({ driverOperator: "is_not", drivers: [HOANG_PHI, THANH_AN] }), [31]);
  eq("is not excludes a smart row if one driver matches", hits({ driverOperator: "is_not", drivers: [VIET_PHI] }), [30, 33]);
  eq("is matches any selected pickup", hits({ pickupOperator: "is", pickups: ["Kho Trung Tâm", "Kho Miền Tây"] }), [30, 33]);
  eq("is not excludes every selected pickup", hits({ pickupOperator: "is_not", pickups: ["Kho Trung Tâm", "Kho Miền Tây"] }), [31, 32]);
  eq("pickup contains is accent-insensitive", hits({ pickupText: "mien dong" }), [32]);
  eq("pickup does not contain", hits({ pickupOperator: "not_contains", pickupText: "kho" }), [31]);
  eq("is matches selected drop-offs", hits({ dropoffOperator: "is", dropoffs: ["Bệnh viện Quận 2", "Phòng khám An Bình"] }), [31, 33]);
  eq("is not excludes selected drop-offs", hits({ dropoffOperator: "is_not", dropoffs: ["Bệnh viện Quận 2", "Phòng khám An Bình"] }), [30, 32]);
  eq("all destinations is an explicit blank selection", hits({ dropoffOperator: "is", dropoffs: [""] }), [32]);
  eq("is not can exclude all-destination rows", hits({ dropoffOperator: "is_not", dropoffs: [""] }), [30, 31, 33]);
  eq("drop-off contains is accent-insensitive", hits({ dropoffText: "phong kham" }), [33]);
  eq("drop-off does not contain", hits({ dropoffOperator: "not_contains", dropoffText: "bệnh viện" }), [32, 33]);
  eq("driver contains one name in a smart row", hits({ driverText: "viết phi" }), [31, 32]);
  eq("driver does not contain excludes a smart row if any name matches", hits({ driverOperator: "not_contains", driverText: "viết phi" }), [30, 33]);
  eq("shift start contains narrows to one time", hits({ startText: "13:00" }), [31]);
  eq("shift start is matches selected times", hits({ startOperator: "is", starts: ["05:00", "07:00"] }), [30, 32]);
  eq("shift end is not excludes a selected time", hits({ endOperator: "is_not", ends: ["16:00"] }), [30, 31, 33]);
  eq("start and end filters combine", hits({ startOperator: "is", starts: ["07:00"], endOperator: "is", ends: ["16:00"] }), [32]);
  eq("blank shift times can be selected", filterConfigRows([...FILTER_ROWS, row({ row: 34 })], {
    ...EMPTY_CONFIG_FILTERS, startOperator: "is", starts: [""], endOperator: "is", ends: [""],
  }).map((r) => r.row), [34]);
  eq("empty text does not activate a negative operator", hits({ driverOperator: "not_contains" }), [30, 31, 32, 33]);
  eq("is not without selections is inactive", hits({ driverOperator: "is_not" }), [30, 31, 32, 33]);
  eq("selected values are inactive in contains mode", hits({ drivers: [HOANG_PHI], driverText: "viết phi" }), [31, 32]);
  eq("text is inactive in is mode", hits({ driverOperator: "is", drivers: [HOANG_PHI], driverText: "viết phi" }), [30]);
  eq("separate controls combine with AND", hits({ driverOperator: "is", drivers: [VIET_PHI], pickupText: "miền", dropoffOperator: "is", dropoffs: [""] }), [32]);

  const options = configFilterOptions(FILTER_ROWS);
  eq("driver options split and deduplicate smart cells", options.drivers.length, 3);
  eq("pickup options are deduplicated", options.pickups.length, 4);
  const pickupOrder = configFilterOptions([
    row({ pickup: "{inactive} Bệnh viện cũ" }),
    row({ pickup: "Bệnh viện mới" }),
    row({ pickup: "{inactive} Phòng khám cũ" }),
  ]).pickups;
  eq("active pickups appear before inactive ones", pickupOrder, [
    "Bệnh viện mới", "{inactive} Bệnh viện cũ", "{inactive} Phòng khám cũ",
  ]);
  eq("all destinations is the first drop-off option", options.dropoffs[0], "");
  eq("shift start options are in clock order", options.starts, ["05:00", "07:00", "08:00", "13:00"]);
  eq("shift end options are in clock order", options.ends, ["13:00", "16:00", "17:00", "21:00"]);
  eq("option ordering is stable", options, configFilterOptions(FILTER_ROWS));
}

console.log(failures === 0 ? "\nAll config-search checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
