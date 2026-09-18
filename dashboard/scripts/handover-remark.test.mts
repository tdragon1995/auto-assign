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
