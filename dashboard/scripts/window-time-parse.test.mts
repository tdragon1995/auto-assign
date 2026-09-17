// npx tsx scripts/window-time-parse.test.mts
import assert from "node:assert/strict";
import { parsePickupWindowTime } from "../src/lib/assign";

const want = new Date("2026-09-17T08:30:00+07:00").getTime();
for (const s of ["08:30:00+07:00", "08:30:00+0700", "08:30:00+07", "8:30:00+07"]) {
  assert.equal(parsePickupWindowTime(s, "2026-09-17")?.getTime(), want, s);
}
for (const s of ["08:30", "08:30:00", "garbage"]) {
  assert.equal(parsePickupWindowTime(s, "2026-09-17"), null, s);
}
console.log("window-time-parse: ok");
