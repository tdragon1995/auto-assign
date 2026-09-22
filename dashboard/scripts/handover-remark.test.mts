/**
 * Pins how a hand-typed hard-copy remark is read into a destination branch.
 *
 *   npx tsx scripts/handover-remark.test.mts
 */
import assert from "node:assert/strict";
import { destFromRemark } from "../src/lib/handover";

const cases: [string | null, string | null][] = [
  ["Bản cứng kết quả gửi về D015", "D015"],   // the template
  ["ban cung kq gui ve d15", "D015"],          // no accents, short code
  ["Bản cứng gửi về Đ 028.", "D028"],          // Đ, space, trailing dot
  ["Bản cứng gửi về D-007", "D007"],
  ["Lấy mẫu tại D001, bản cứng gửi về D015", "D015"], // two codes, "về" decides
  ["D001 D015", null],                          // two codes, nothing decides
  ["Bản cứng gửi về D999", null],               // not a real branch
  ["Gửi về D0", null],                          // cut off
  ["BIDV01 xin gửi", null],                     // D inside a word
  ["", null],
  [null, null],
];

for (const [input, want] of cases) assert.equal(destFromRemark(input), want, String(input));
console.log(`ok — ${cases.length} cases`);

// The route joins Ghi chú and Bệnh sử with " | " — the sentence may sit in either.
assert.equal(destFromRemark("Thời gian lấy mẫu 12:04 ngày 17/9/2026 | Bản cứng kết quả gửi về D015"), "D015");
assert.equal(destFromRemark("Bản cứng gửi về D015 | Thời gian lấy mẫu 12:04"), "D015");
console.log("ok — joined notes");

// ── Pasted rows + billing match ──
import { parsePaste, billingFound } from "../src/lib/handover";

assert.deepEqual(parsePaste("26020669640\tBlomia Tropicalis - Bt (d201)\n26020669640\tHbA1c\n26020669641"), [
  { vid: "26020669640", billing: "Blomia Tropicalis - Bt (d201)" },
  { vid: "26020669640", billing: "HbA1c" },           // same VID, second billing → its own row
  { vid: "26020669641", billing: "" },                 // no billing pasted → blank
]);
assert.deepEqual(parsePaste("26020669640, 26020669641 26020669642"), [
  { vid: "26020669640", billing: "" }, { vid: "26020669641", billing: "" }, { vid: "26020669642", billing: "" },
]);
assert.deepEqual(parsePaste("26020669640 hba1c\n26020669640   HbA1c "), [{ vid: "26020669640", billing: "hba1c" }]); // duplicate line
assert.deepEqual(parsePaste("Cholesterol, toàn phần 26020669640"), [{ vid: "26020669640", billing: "Cholesterol, toàn phần" }]);

const names = ["Blomia Tropicalis - Bt (d201)", "Định lượng Glucose"];
assert.equal(billingFound("blomia tropicalis - bt (d201)", names), true);
assert.equal(billingFound("dinh luong glucose", names), true);   // accents ignored
assert.equal(billingFound("d201", names), true);                 // part of a name
assert.equal(billingFound("HbA1c", names), false);
assert.equal(billingFound("", names), false);
console.log("ok — paste + billing");

// ── Real paste from 22/09: VID, patient name, test name — three Excel columns ──
import { stripPatient } from "../src/lib/handover";
const nipt = ["NIPT 7* + Carrier Screening 18**", "NIPT 7* + Sàng Lọc 18 Gen Lặn**"];
for (const [line, patient] of [
  ["26050623282\tĐẶNG PHƯƠNG LAN\tCarrier Screening 18 **", "ĐẶNG PHƯƠNG LAN"],
  ["26050626506\tLÊ THỊ HOÀNG PHI\tCarrier Screening 18 **", "LÊ THỊ HOÀNG PHI"],
  ["26050626521 Nguyễn Vũ Thảo Nguyên  Carrier Screening 18 **", "NGUYỄN VŨ THẢO NGUYÊN"], // typed case, spaces
]) {
  const [{ billing }] = parsePaste(line);
  const cleaned = stripPatient(billing, patient);
  assert.equal(cleaned, "Carrier Screening 18 **", line);
  assert.equal(billingFound(cleaned, nipt), true, line);   // space before ** ignored
}
assert.equal(stripPatient("HbA1c", "ĐẶNG PHƯƠNG LAN"), "HbA1c");  // no patient name → untouched
assert.equal(stripPatient("HbA1c", null), "HbA1c");
assert.equal(billingFound("Carrier Screening 19 **", nipt), false);
console.log("ok — patient name stripped, spacing ignored");
