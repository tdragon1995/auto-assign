/**
 * One branch, two destinations, two drivers: "D014 → D001 is Nam, D014 → D007 is Hùng".
 *
 * Before the dropoff_id column a mapping row answered for a PICKUP and nothing else,
 * so a branch that sends samples to two places under two drivers could not be written
 * down at all. The column makes it expressible — but it lands in a table where a
 * second row for the same pickup already MEANS something: two rows whose shifts
 * overlap is a CLASH, and the engine refuses a clash rather than guess. Adding
 * "D014 → D007 is Hùng" beside the existing "D014 is Nam" row would therefore have
 * stopped D014 assigning altogether, which is the failure this file exists to prevent.
 *
 * The rule is most-specific-wins, applied AFTER the shift filter:
 *   • a blank dropoff_id serves any destination — every legacy row, unchanged;
 *   • a row naming this destination REPLACES the blank row rather than competing;
 *   • a row naming a different destination is dropped outright;
 *   • but only among rows that are actually on shift, so a destination row that has
 *     closed hands the job back to the branch's general row instead of blocking it.
 *     Nobody loses coverage they already had by adding a destination row.
 */
import { getDriversOnDuty, findSmartMapping } from "../src/lib/fixed-driver";
import type { Config, Mapping } from "../src/lib/types";

let failures = 0;
function ok(label: string, cond: boolean) {
  console.log(`  ${cond ? "ok  " : "FAIL"}   ${label}`);
  if (!cond) failures++;
}

const D014 = "cust-d014";
const D001 = "cust-d001";
const D007 = "cust-d007";
const D016 = "cust-d016";

const NAM = "11111111-1111-1111-1111-111111111111";
const HUNG = "22222222-2222-2222-2222-222222222222";
const TUAN = "33333333-3333-3333-3333-333333333333";

function row(
  customer_id: string,
  dropoff_id: string,
  driver_id: string,
  start: string,
  end: string,
  smart: string[] = [],
): Mapping {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return {
    customer_id,
    dropoff_id,
    driver_id,
    smart_driver_id: smart,
    first_name_last_name: driver_id,
    shift_start: { hours: sh, minutes: sm },
    shift_end: { hours: eh, minutes: em },
    bot_token: "",
    chat_id: "",
    alt_drop_off_id: "",
  };
}

/** A Date whose Saigon wall clock reads HH:MM. VN is UTC+7 with no DST, so
 *  subtracting 7 hours in UTC is exact. */
function vnAt(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2026, 7, 26, h - 7, m));
}

const cfg = (mappings: Mapping[]): Config => ({ mappings });

// ── 1. The legacy shape still works ──────────────────────────────────────────
console.log("\n1. A blank dropoff_id serves every destination (all ~1,700 legacy rows)");
{
  const c = cfg([row(D014, "", NAM, "05:00", "18:00")]);
  for (const dest of [D001, D007, D016, null]) {
    const [drivers, status] = getDriversOnDuty(c, D014, vnAt("09:00"), dest);
    ok(`→ ${dest ?? "(no dropoff stop)"} → Nam`, status === "happy" && drivers[0].driver_id === NAM);
  }
}

// ── 2. The case this was built for ───────────────────────────────────────────
console.log("\n2. D014 → D001 is Nam, D014 → D007 is Hùng");
{
  const c = cfg([
    row(D014, D001, NAM, "05:00", "18:00"),
    row(D014, D007, HUNG, "05:00", "18:00"),
  ]);
  const [toD001, s1] = getDriversOnDuty(c, D014, vnAt("09:00"), D001);
  ok("→ D001 picks Nam", s1 === "happy" && toD001[0].driver_id === NAM);

  const [toD007, s2] = getDriversOnDuty(c, D014, vnAt("09:00"), D007);
  ok("→ D007 picks Hùng", s2 === "happy" && toD007[0].driver_id === HUNG);

  const [, s3] = getDriversOnDuty(c, D014, vnAt("09:00"), D016);
  ok("→ D016 is NO DROPOFF RULE, not NO MAPPING", s3 === "no_dropoff_rule");

  const [, s4] = getDriversOnDuty(c, D014, vnAt("09:00"), null);
  ok("job with no dropoff stop matches nothing", s4 === "no_dropoff_rule");

  const [, s5] = getDriversOnDuty(c, "cust-unknown", vnAt("09:00"), D001);
  ok("an unconfigured branch is still NO MAPPING", s5 === "no_mapping");
}

// ── 3. The regression that would have broken D014 the day it shipped ─────────
console.log("\n3. A destination row beside a general row is NOT a clash");
{
  const c = cfg([
    row(D014, "", NAM, "05:00", "18:00"),      // the row that exists today
    row(D014, D007, HUNG, "05:00", "18:00"),   // the row a supervisor adds
  ]);
  const [toD007, s1] = getDriversOnDuty(c, D014, vnAt("09:00"), D007);
  ok("→ D007 picks Hùng (specific beats general)", s1 === "happy" && toD007[0].driver_id === HUNG);

  const [toD001, s2] = getDriversOnDuty(c, D014, vnAt("09:00"), D001);
  ok("→ D001 still picks Nam", s2 === "happy" && toD001[0].driver_id === NAM);

  const [toD016, s3] = getDriversOnDuty(c, D014, vnAt("09:00"), D016);
  ok("→ anywhere else still picks Nam", s3 === "happy" && toD016[0].driver_id === NAM);
}

// ── 4. Adding a destination row can never REMOVE coverage ────────────────────
console.log("\n4. An off-shift destination row hands the job back to the general row");
{
  const c = cfg([
    row(D014, "", NAM, "05:00", "18:00"),
    row(D014, D007, HUNG, "06:00", "10:00"),   // morning only
  ]);
  const [inWindow, s1] = getDriversOnDuty(c, D014, vnAt("08:00"), D007);
  ok("08:00 → Hùng", s1 === "happy" && inWindow[0].driver_id === HUNG);

  const [after, s2] = getDriversOnDuty(c, D014, vnAt("14:00"), D007);
  ok("14:00 → falls back to Nam, not NO DRIVER", s2 === "happy" && after[0].driver_id === NAM);
}

// ── 5. Genuine ambiguity is still refused ────────────────────────────────────
console.log("\n5. Two rows for the SAME destination on overlapping shifts still clash");
{
  const c = cfg([
    row(D014, D007, HUNG, "05:00", "18:00"),
    row(D014, D007, TUAN, "05:00", "18:00"),
  ]);
  const [, s] = getDriversOnDuty(c, D014, vnAt("09:00"), D007);
  ok("→ CLASH, the engine does not guess", s === "clash");
}
console.log("\n   ...and nobody on shift is still NO DRIVER, not NO DROPOFF RULE");
{
  const c = cfg([row(D014, D007, HUNG, "06:00", "10:00")]);
  const [shifts, s] = getDriversOnDuty(c, D014, vnAt("14:00"), D007);
  ok("→ no_driver, and the shift is reported", s === "no_driver" && shifts.length === 1);
}

// ── 6. The smart pool follows the same rule ──────────────────────────────────
console.log("\n6. A destination-scoped smart pool beats the branch's general pool");
{
  // Sheet order deliberately puts the general row FIRST: the old lookup took the
  // first on-shift smart row it found, so row order would have decided the answer.
  const c = cfg([
    row(D014, "", "", "05:00", "18:00", [NAM]),
    row(D014, D007, "", "05:00", "18:00", [HUNG, TUAN]),
  ]);
  const toD007 = findSmartMapping(c, D014, vnAt("09:00"), D007);
  ok("→ D007 gets the D007 pool", toD007?.smart_driver_id.join() === [HUNG, TUAN].join());

  const toD001 = findSmartMapping(c, D014, vnAt("09:00"), D001);
  ok("→ D001 gets the general pool", toD001?.smart_driver_id.join() === NAM);

  const offShift = findSmartMapping(c, D014, vnAt("03:00"), D007);
  ok("→ nothing on shift returns undefined", offShift === undefined);
}

console.log(failures === 0 ? "\nAll passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
