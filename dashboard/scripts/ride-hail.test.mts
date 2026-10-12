// npx tsx scripts/ride-hail.test.mts — the amount an admin types is money.
import assert from "node:assert/strict";
import { parseVnd } from "../src/lib/ride-hail";

assert.equal(parseVnd("85000"), 85000);
assert.equal(parseVnd("85.000"), 85000);
assert.equal(parseVnd("85,000đ"), 85000);
assert.equal(parseVnd(" 1.250.000 "), 1250000);
for (const bad of ["", "0", "-5000", "85k", "12.5", "abc", "999999999"]) assert.equal(parseVnd(bad), null, bad);
console.log("ride-hail: ok");
