import assert from "node:assert/strict";
import { danangPickupNote, validDanangPhone } from "../src/lib/danang";

assert.equal(validDanangPhone("0901234567"), true);
assert.equal(validDanangPhone(" 0901234567 "), true);
assert.equal(validDanangPhone("1234567890"), false);
assert.equal(validDanangPhone("090123456"), false);
assert.equal(validDanangPhone("090123456a"), false);
assert.equal(
  danangPickupNote("  Mẫu khẩn  ", "  Nguyễn Văn A  ", "0901234567"),
  "Mẫu khẩn\nTên nhân viên: Nguyễn Văn A\nSố Điện Thoại Nhân Viên: 0901234567"
);
assert.equal(
  danangPickupNote("", "Nguyễn Văn A", "0901234567"),
  "Tên nhân viên: Nguyễn Văn A\nSố Điện Thoại Nhân Viên: 0901234567"
);
