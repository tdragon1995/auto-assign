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
 * And which NAMES share a line in it.
 *
 * The week grid shows names with no staff code, so a person holding both a
 * full-time `DC…` and a part-time `PT…` account arrived as the same name twice
 * in a column with nothing to say why. `mergePeople` puts them on one line. The
 * guard is the whole test: Vietnamese names repeat, so two DIFFERENT full-time
 * drivers can share a spelling, and merging THOSE would delete a person from
 * the day — silently, since the line would still be there under the other one's
 * name.
 *
 *   npx tsx scripts/leave-week.test.mts
 */

import { weekStartOf, mergePeople } from "../src/components/leave-status-panel";

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

// --- merging a person's two accounts -----------------------------------------

type Sub = { id: string; name: string };
const row = (subs: Sub[] = []) => ({ timeLabel: null, subs, leave_from: "2026-09-07", duplicate: false });
const group = (driver_id: string, driver_name: string, opts: { subs?: Sub[]; loai_nghi?: string } = {}) => ({
  driver_id,
  driver_name,
  loai_nghi: opts.loai_nghi ?? "Nghỉ nguyên buổi",
  leave_from: "2026-09-07",
  rows: [row(opts.subs)],
});
const someone: Sub = { id: "x", name: "F - C - DC100999 Người Thay" };

console.log("\nmerging accounts onto one line");
{
  const cells = mergePeople([
    group("a", "F - C - DC100320 Lý Chánh Hùng"),
    group("b", "F - C - PT100320 Lý Chánh Hùng"),
  ]);
  eq("a full-time and a part-time twin become ONE line", cells.length, 1);
  eq("both accounts hang off it", cells[0]?.groups.length, 2);
  eq("and it is labelled with both", cells[0]?.employments.join("+"), "full-time+part-time");
}
{
  const cells = mergePeople([
    group("a", "F - C - DC100001 Nguyễn Văn Hùng"),
    group("b", "F - P - DC100002 Nguyễn Văn Hùng"),
  ]);
  eq("two FULL-TIME accounts sharing a name stay two lines", cells.length, 2);
}
{
  const cells = mergePeople([
    group("a", "Admin Lý Thị Thùy Linh"),
    group("b", "Admin Lý Thị Thùy Linh"),
  ]);
  eq("no staff code to read means no merge either", cells.length, 2);
}

console.log("what the line says");
{
  const [cell] = mergePeople([
    group("a", "F - C - DC100320 Lý Chánh Hùng", { subs: [someone] }),
    group("b", "F - C - PT100320 Lý Chánh Hùng"),
  ]);
  eq("one covered account and one open reads as OPEN", cell?.status, "uncovered");
}
{
  const [cell] = mergePeople([
    group("a", "F - C - DC100320 Lý Chánh Hùng", { subs: [someone] }),
    group("b", "F - C - PT100320 Lý Chánh Hùng", { subs: [someone] }),
  ]);
  eq("both covered reads as covered", cell?.status, "covered");
}
{
  const [cell] = mergePeople([
    group("a", "F - C - DC100320 Lý Chánh Hùng", { subs: [someone] }),
    group("b", "F - C - PT100320 Lý Chánh Hùng", { loai_nghi: "Nghỉ việc" }),
  ]);
  eq("a resigned account outranks a covered one", cell?.status, "resigned");
}
{
  const cells = mergePeople([
    group("b", "F - C - DC100002 Trần Ánh"),
    group("a", "F - C - DC100001 Đặng An"),
  ]);
  eq("lines come out ordered by the person, in vi", cells.map((c) => c.name).join(", "),
    "Đặng An, Trần Ánh");
}

console.log(failures === 0 ? "\nAll leave-week checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
