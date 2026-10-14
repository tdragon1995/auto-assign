/**
 * /qr client search ranking. Run: npx tsx scripts/customer-search.test.mts
 *
 * The bug it pins: "tri phuong" (a street) listed "Trịnh Hoài Đức, Phường Mỹ Tho"
 * first, because each word was matched anywhere.
 */
import assert from "node:assert/strict";
import { indexCustomer, rankCustomers } from "../src/lib/customer-search";

const all = [
  { customer_id: "a", customer_name: "25372 - MTho - PHÒNG KHÁM ĐOÀN NGA", address_line_1: "146 Trịnh Hoài Đức, Phường Mỹ Tho" },
  { customer_id: "b", customer_name: "11 - D10 - Phòng khám Hòa Hảo", address_line_1: "254 Tri Phương, Phường 4, Quận 10" },
  { customer_id: "c", customer_name: "12 - D10 - Nha khoa Tri Phương", address_line_1: "1 Ba Tháng Hai" },
  { customer_id: "d", customer_name: "13 - D2 - Trí Đức", address_line_1: "9 Lê Lợi" },
  { customer_id: "e", customer_name: "14 - BThanh - PK Nhật Bình", address_line_1: "36 Nguyễn Gia Trí, Phường 25" },
  { customer_id: "f", customer_name: "{inactive} 15 - D10 - Tri Phương cũ", address_line_1: "" },
].map(indexCustomer);
const ids = (q: string) => rankCustomers(all, q).map((c) => c.customer_id);

// Phrase in the name first, then in the address; scattered words dropped once a phrase hits.
assert.deepEqual(ids("tri phuong"), ["c", "b"]);
assert.deepEqual(ids("Tri Phương"), ["c", "b"]);
// No phrase anywhere → words at word starts still find it.
assert.deepEqual(ids("doan nga my tho"), ["a"]);
// A word must START a word: "uong" is inside "phuong", not a word start.
assert.deepEqual(ids("uong"), []);
// "Trí, Phường" is not the phrase "tri phuong"; inactive customers never show.
assert.ok(!ids("tri phuong").includes("e"));
assert.ok(!ids("tri phuong cu").includes("f"));
// Too short to search.
assert.deepEqual(ids("t"), []);
console.log("customer-search: ok");
