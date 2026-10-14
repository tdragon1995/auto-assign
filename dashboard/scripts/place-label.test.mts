// Run: npx tsx scripts/place-label.test.mts — how place names read on /qr, /psc-tinh, /ao.
import assert from "node:assert/strict";
import { placeLabel } from "../src/lib/place-label";

const cases: [string, string][] = [
  ["49391269 - KGiang - Lạc Hồng - Công ty TNHH MTV PKĐK TRUNG CANG", "PKĐK TRUNG CANG"],
  ["CÔNG TY CỔ PHẦN BỆNH VIỆN HOÀN MỸ BÌNH PHƯỚC", "BỆNH VIỆN HOÀN MỸ BÌNH PHƯỚC"],
  ["Công ty TNHH một thành viên Y tế ABC", "Y tế ABC"],
  ["BRA - D006", "D006"],
  ["Phòng Khám Bác Sỹ Võ Thanh Liên Anh", "Phòng Khám Bác Sỹ Võ Thanh Liên Anh"],
  ["Công ty MTV Xanh", "Công ty MTV Xanh"], // no legal form before MTV: left alone
];
for (const [input, want] of cases) assert.equal(placeLabel(input), want, input);
console.log(`PASS: ${cases.length} place names`);
