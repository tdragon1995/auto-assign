/**
 * Which Monday a date belongs to.
 *
 * The leave panel pages by WEEK now, so this one function decides what seven
 * days a supervisor is looking at. Two ways it could be quietly wrong, both of
 * which would show the correct-looking number of days for the wrong stretch:
 *
 *   1. WEEK START. Monday, not Sunday. The roster runs Monday to Saturday, so a
 *      Sunday-start week splits the busiest stretch across two pages — and a
 *      Sunday would land at the END of the week it belongs to.
 *   2. TIMEZONE. Read as UTC, never local. `new Date("2026-09-06")` is midnight
 *      UTC, which in Saigon is already the 6th but in New York is still the 5th;
 *      a local read would shift the whole week by a day for half the world, and
 *      the server this runs against is not in Saigon.
 *
 *   npx tsx scripts/leave-week.test.mts
 */

import { weekStartOf } from "../src/components/leave-status-panel";

let failures = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  if (got === want) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

// 2026-09-07 is a Monday; 09-13 the Sunday that closes the same week.
console.log("finding the week");
eq("a Monday is its own week start", weekStartOf("2026-09-07"), "2026-09-07");
eq("Tuesday belongs to it", weekStartOf("2026-09-08"), "2026-09-07");
eq("so does Saturday", weekStartOf("2026-09-12"), "2026-09-07");
eq("and Sunday CLOSES that week rather than opening the next",
  weekStartOf("2026-09-13"), "2026-09-07");
eq("the next Monday starts a new one", weekStartOf("2026-09-14"), "2026-09-14");

console.log("edges");
// A Sunday-start week would answer 2025-12-28 here; a local-time read would
// shift either answer by a day west of UTC.
eq("a week spanning new year keeps its Monday", weekStartOf("2026-01-01"), "2025-12-29");
eq("a leap day resolves like any other", weekStartOf("2028-02-29"), "2028-02-28");
eq("the first of a month mid-week walks back", weekStartOf("2026-09-01"), "2026-08-31");

console.log("bad input");
eq("garbage comes back untouched rather than as an epoch week",
  weekStartOf("not-a-date"), "not-a-date");
eq("empty stays empty", weekStartOf(""), "");

console.log(failures === 0 ? "\nAll leave-week checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
