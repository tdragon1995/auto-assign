/**
 * Pins how a hand-typed hard-copy remark is read into a destination branch.
 *
 *   npx tsx scripts/handover-remark.test.mts
 */
import assert from "node:assert/strict";
import { destFromRemark, displayClientName, printRowKey } from "../src/lib/handover";

assert.equal(displayClientName("CÔNG TY CỔ PHẦN y khoa Việt"), "Y khoa Việt");
assert.equal(displayClientName("Công ty trách nhiệm hữu hạn y khoa Việt"), "Y khoa Việt");
assert.equal(displayClientName("Công ty TNHH thiên an"), "Thiên an");
assert.equal(displayClientName("Cty TNHH y tế An"), "Y tế An");
assert.equal(displayClientName("CTCP dịch vụ Việt"), "Dịch vụ Việt");
assert.equal(displayClientName("Hộ kinh doanh phòng khám An"), "Phòng khám An");
assert.equal(displayClientName("DOANH NGHIỆP TƯ NHÂN PHÒNG KHÁM BỆNH ĐA KHOA BÁC SĨ BẢNH"), "PHÒNG KHÁM BỆNH ĐA KHOA BÁC SĨ BẢNH");
assert.equal(displayClientName("Công TNHH Phát Triển Công Nghệ Anapath"), "Phát Triển Công Nghệ Anapath");
assert.equal(displayClientName("25372 - MTho - THDuc - HỘ KINH DOANH phòng khám An"), "25372 - MTho - THDuc - Phòng khám An");
assert.equal(displayClientName("123 - D5 - A - Công ty TNHH phòng khám An"), "123 - D5 - A - Phòng khám An");
assert.equal(displayClientName("phòng khám An"), "Phòng khám An");
assert.equal(displayClientName("CHI NHÁNH CÔNG TY TNHH DYM MEDICAL CENTER VIỆT NAM"), "DYM MEDICAL CENTER VIỆT NAM");
assert.equal(displayClientName("123 - D5 - A - Chi nhánh phòng khám An"), "123 - D5 - A - phòng khám An");
assert.equal(displayClientName("Phòng khám An chi nhánh 2"), "Phòng khám An chi nhánh 2"); // only a leading one
assert.equal(printRowKey({ vid: "12345678", billing: "Xét nghiệm A" }), printRowKey({ vid: "12345678", billing: "xet nghiem  a" }));
assert.notEqual(printRowKey({ vid: "12345678", billing: "Xét nghiệm A" }), printRowKey({ vid: "12345678", billing: "Xét nghiệm B" }));

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
assert.equal(billingFound("d201", names), false);                // part of a name is not enough
assert.equal(billingFound("HbA1c", names), false);
assert.equal(billingFound("", names), false);
console.log("ok — paste + billing");

// ── Real paste from 22/09: VID, patient name, test name — three Excel columns ──
import { stripNames as stripPatient } from "../src/lib/handover";
const nipt = ["NIPT 7* + Carrier Screening 18**", "NIPT 7* + Sàng Lọc 18 Gen Lặn**"];
for (const [line, patient] of [
  ["26050623282\tĐẶNG PHƯƠNG LAN\tCarrier Screening 18 **", "ĐẶNG PHƯƠNG LAN"],
  ["26050626506\tLÊ THỊ HOÀNG PHI\tCarrier Screening 18 **", "LÊ THỊ HOÀNG PHI"],
  ["26050626521 Nguyễn Vũ Thảo Nguyên  Carrier Screening 18 **", "NGUYỄN VŨ THẢO NGUYÊN"], // typed case, spaces
]) {
  const [{ billing }] = parsePaste(line);
  const cleaned = stripPatient(billing, patient);
  assert.equal(cleaned, "Carrier Screening 18 **", line);
  assert.equal(billingFound(cleaned, nipt), false, line);  // only part of "NIPT 7* + Carrier Screening 18**"
}
assert.equal(stripPatient("HbA1c", "ĐẶNG PHƯƠNG LAN"), "HbA1c");  // no patient name → untouched
assert.equal(stripPatient("HbA1c", null), "HbA1c");
assert.equal(billingFound("Carrier Screening 19 **", nipt), false);
console.log("ok — patient name stripped, spacing ignored");

// ── Real paste from 20/10: VID, test, client name, patient — the client name landed in Xét nghiệm ──
{
  const client = "CHI NHÁNH CÔNG TY TNHH DYM MEDICAL CENTER VIỆT NAM TẠI THÀNH PHỐ HỒ CHÍ MINH";
  const [{ billing }] = parsePaste(`26050755976\tPapsmear\t${client}\tTRẦN THỊ KIM KHOA`);
  assert.equal(stripPatient(billing, "TRẦN THỊ KIM KHOA", client), "Papsmear");
  console.log("ok — client name stripped");
}

// Exact whole-name match: case, accents and spacing ignored, nothing else.
assert.equal(billingFound("NIPT 7* + Carrier Screening 18 **", nipt), true);  // space before ** ignored
assert.equal(billingFound("nipt 7* + sang loc 18 gen lan**", nipt), true);    // no accents, lower case
assert.equal(billingFound("NIPT 7* + Carrier Screening", nipt), false);       // end missing
assert.equal(billingFound("NIPT 7* + Carier Screening 18**", nipt), false);   // typo
assert.equal(billingFound("Rubella IgG", ["Rubella IgG miễn dịch tự động", "Rubella IgG"]), true); // test_name
console.log("ok — exact match");

// ── Result status: which pending tests a row stands for ──
import { pendingFor, isPending } from "../src/lib/handover";
const entries = [
  { names: ["NIPT 7* + Carrier Screening 18**"], codes: ["CS18-TV", "NIPT7-DD"] },   // package → its parts
  { names: ["Carrier Screening 18 **"], codes: ["CS18-TV"] },
  { names: ["NIPT 7*"], codes: ["NIPT7-DD"] },
  { names: ["Rubella IgG", "Rubella IgG miễn dịch tự động"], codes: ["5334-8"] },
];
const pend = [{ code: "NIPT7-DD", name: "NIPT 7*", status: "sample_received" }];
assert.deepEqual(pendingFor("NIPT 7*", entries, pend), pend);
assert.deepEqual(pendingFor("NIPT 7* + Carrier Screening 18**", entries, pend), pend); // package covers its part
assert.deepEqual(pendingFor("Carrier Screening 18 **", entries, pend), []);             // this part is done
assert.deepEqual(pendingFor("Rubella IgG", entries, pend), []);
assert.deepEqual(pendingFor("", entries, pend), pend);                                   // nothing pasted → whole order
assert.deepEqual(pendingFor("HbA1c", entries, pend), []);                                // not on the order → ✗ says so already
assert.equal(pendingFor("NIPT 7*", entries, null), null);                                // status unreadable
assert.equal(isPending("approved"), false);
assert.equal(isPending("sample_received"), true);
assert.equal(isPending("cancelled"), false);
console.log("ok — result status");

// ── Exclusion list ──
import { isExcluded, exclusionsOf } from "../src/lib/handover";
{
  const dym = "CHI NHÁNH CÔNG TY TNHH DYM MEDICAL CENTER VIỆT NAM TẠI THÀNH PHỐ HỒ CHÍ MINH";
  const whole = [{ client_code: "18513", client_name: dym, tests: [] }];
  const pap = [{ client_code: "18513", client_name: dym, tests: [{ code: "47527-7CR", names: ["Pap Smear"] }] }];
  const row = { client_code: "18513", client: "x", billing: "", test_codes: ["47527-7CR"] };
  assert.equal(isExcluded(row, whole), true);                                         // no tests → whole client
  assert.equal(isExcluded({ ...row, client_code: "999" }, whole), false);              // other client
  assert.equal(isExcluded({ ...row, client_code: null, client: "DYM medical center việt nam tại thành phố hồ chí minh" }, whole), true); // saved row: by printed name
  assert.equal(isExcluded({ ...row, billing: "pap smear" }, pap), true);               // pasted test is listed
  assert.equal(isExcluded({ ...row, billing: "HbA1c" }, pap), false);                  // pasted test is not
  assert.equal(isExcluded(row, pap), true);                                            // bare VID, every test listed
  assert.equal(isExcluded({ ...row, test_codes: ["47527-7CR", "4548-4"] }, pap), false); // bare VID with another test too
  assert.equal(isExcluded({ ...row, test_codes: undefined }, pap), false);             // tests unknown → keep
  assert.deepEqual(exclusionsOf(pap), pap);
  assert.equal(exclusionsOf([{ client_code: "", client_name: "a", tests: [] }]), null);
  assert.deepEqual(exclusionsOf(null), null);
  console.log("ok — exclusion list");
}
