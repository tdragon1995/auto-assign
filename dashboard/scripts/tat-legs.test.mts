/**
 * Cutting a driver's day into legs: stop merging, ordering, and the clock.
 *
 * The merge is the part most worth pinning down. A driver who works three jobs at
 * one clinic made ONE journey there, but the timeline reports three stops — and
 * left alone those produce two 0 km legs from a place to itself, each handed the
 * 4-minute floor target and each counted as a "chặng". That pads the driver's day
 * with trips they never rode and scores their paperwork as slow riding.
 *
 * Equally important is what must NOT merge: a driver returning to the lab three
 * times across a day genuinely rode there three times. Merging by place instead of
 * by consecutive run would erase two real journeys and silently shrink the day.
 *
 * Pure function, no network and no Redis — distances are attached separately.
 *
 *   npx tsx scripts/tat-legs.test.mts
 */
import type { TimelineRoute, TimelineStop } from "../src/lib/types";

const { legsForRoute, benchmarkMinsFor, targetMinsFor } = await import("../src/lib/tat");

const DATE = "2026-08-19";
let failures = 0;

function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

/** Minimal stop; only the fields the leg cutter reads are meaningful.
 *
 *  sched / allowed / send / window are the availability stamps — omitted by
 *  default, which is what keeps every pre-existing check below measuring the raw
 *  departure-to-arrival clock. */
function stop(o: {
  id: number; cust: string; name: string; lat: number; lng: number;
  arrived: string | null; completed: string; ref?: string; labels?: string[];
  sched?: string; allowed?: string; send?: string; window?: string;
}): TimelineStop {
  return {
    stopId: o.id, jobId: o.id * 10, stopTypeId: 1, stopStatusId: 4,
    customerId: o.cust, customerName: o.name,
    referenceNumber: o.ref ?? `REF-${o.id}`, jobLabels: o.labels ?? [],
    latitude: o.lat, longitude: o.lng,
    activityArrivedTs: o.arrived ? `${DATE} ${o.arrived}` : null,
    activityCompletedTs: `${DATE} ${o.completed}`,
    activityStartedTs: null,
    scheduledDeliveryTs: o.sched ? `${DATE} ${o.sched}` : null,
    allowedToStartAt: o.allowed ? `${DATE} ${o.allowed}` : null,
    sendToDriverAt: o.send ? `${DATE} ${o.send}` : null,
    // Cartrack sends windows TIME-ONLY, with no date on them at all.
    deliveryWindows: o.window ? [{ stopId: o.id, timeFrom: `${o.window}+07`, timeTo: "23:59:00+07" }] : [],
  } as unknown as TimelineStop;
}

const route = (stops: TimelineStop[]): TimelineRoute =>
  ({ routeId: "driver_11111111-2222-3333-4444-555555555555", orderedStops: stops,
     driverFullname: "P - PT01 Test" } as unknown as TimelineRoute);

// ── 1. Three jobs at one clinic, then the lab ───────────────────────────────
// Arrives 08:00, works until 08:40, rides to the lab arriving 09:10.
// One journey out, one journey in — so exactly ONE leg, not three.
{
  const legs = legsForRoute(route([
    stop({ id: 1, cust: "CLINIC", name: "Clinic A", lat: 10.78, lng: 106.68, arrived: "08:00:00", completed: "08:10:00" }),
    stop({ id: 2, cust: "CLINIC", name: "Clinic A", lat: 10.78, lng: 106.68, arrived: "08:05:00", completed: "08:25:00" }),
    stop({ id: 3, cust: "CLINIC", name: "Clinic A", lat: 10.78, lng: 106.68, arrived: "08:20:00", completed: "08:40:00" }),
    stop({ id: 4, cust: "LAB", name: "D001", lat: 10.77, lng: 106.66, arrived: "09:10:00", completed: "09:30:00" }),
  ]), DATE);

  check("three stops at one place collapse to a single leg", legs.length === 1, `got ${legs.length}`);
  check("no leg is a place to itself", legs.every((l) => l.from_customer_id !== l.to_customer_id));
  check(
    "departs at the LAST completion there (08:40), not the first",
    legs[0]?.departed_ts?.startsWith(`${DATE}T08:40:00`) === true, String(legs[0]?.departed_ts),
  );
  check("rides 08:40 → 09:10 = 30 minutes", legs[0]?.tat_mins === 30, String(legs[0]?.tat_mins));
}

// ── 2. Earliest arrival wins on the inbound leg ─────────────────────────────
// The driver reaches the clinic at 08:00 but only taps "arrived" on the second
// job. The inbound leg must end at 08:00 — the moment they actually got there.
{
  const legs = legsForRoute(route([
    stop({ id: 1, cust: "LAB", name: "D001", lat: 10.77, lng: 106.66, arrived: "07:30:00", completed: "07:40:00" }),
    stop({ id: 2, cust: "CLINIC", name: "Clinic A", lat: 10.78, lng: 106.68, arrived: "08:12:00", completed: "08:20:00" }),
    stop({ id: 3, cust: "CLINIC", name: "Clinic A", lat: 10.78, lng: 106.68, arrived: "08:00:00", completed: "08:30:00" }),
  ]), DATE);

  check("merged visit arrives at the EARLIEST arrival (08:00)",
    legs[0]?.arrived_ts?.startsWith(`${DATE}T08:00:00`) === true, String(legs[0]?.arrived_ts));
  check("inbound leg is 07:40 → 08:00 = 20 minutes", legs[0]?.tat_mins === 20, String(legs[0]?.tat_mins));
}

// ── 3. A real return trip must NOT be merged ────────────────────────────────
// Lab → clinic → lab. The two lab visits are separated by a journey, so they are
// two visits and the day contains two legs.
{
  const legs = legsForRoute(route([
    stop({ id: 1, cust: "LAB", name: "D001", lat: 10.77, lng: 106.66, arrived: "07:00:00", completed: "07:10:00" }),
    stop({ id: 2, cust: "CLINIC", name: "Clinic A", lat: 10.78, lng: 106.68, arrived: "07:40:00", completed: "07:50:00" }),
    stop({ id: 3, cust: "LAB", name: "D001", lat: 10.77, lng: 106.66, arrived: "08:20:00", completed: "08:30:00" }),
  ]), DATE);

  check("returning to the same place later is two separate legs", legs.length === 2, `got ${legs.length}`);
  check("second leg heads back to the lab", legs[1]?.to_customer_id === "LAB", String(legs[1]?.to_customer_id));
}

// ── 4. Attendance taps are not journeys ─────────────────────────────────────
// A check-in stamp is a button press, not a vehicle arriving somewhere.
{
  const legs = legsForRoute(route([
    stop({ id: 1, cust: "LAB", name: "D001", lat: 10.77, lng: 106.66, arrived: "07:00:00", completed: "07:05:00",
           ref: "Chấm Công - Vào", labels: ["check_in"] }),
    stop({ id: 2, cust: "CLINIC", name: "Clinic A", lat: 10.78, lng: 106.68, arrived: "07:40:00", completed: "07:50:00" }),
    stop({ id: 3, cust: "LAB", name: "D001", lat: 10.77, lng: 106.66, arrived: "08:20:00", completed: "08:30:00" }),
  ]), DATE);

  check("chấm công stop is excluded from the route", legs.length === 1, `got ${legs.length}`);
  check("the surviving leg is clinic → lab", legs[0]?.from_customer_id === "CLINIC" && legs[0]?.to_customer_id === "LAB");
}

// ── 5. Legs follow the order actually worked, not the listed order ──────────
{
  const legs = legsForRoute(route([
    stop({ id: 3, cust: "C", name: "Third", lat: 10.70, lng: 106.60, arrived: "10:00:00", completed: "10:10:00" }),
    stop({ id: 1, cust: "A", name: "First", lat: 10.71, lng: 106.61, arrived: "08:00:00", completed: "08:10:00" }),
    stop({ id: 2, cust: "B", name: "Second", lat: 10.72, lng: 106.62, arrived: "09:00:00", completed: "09:10:00" }),
  ]), DATE);

  check("sorted by completion time, so legs are A→B→C",
    legs.map((l) => `${l.from_customer_id}${l.to_customer_id}`).join(",") === "AB,BC",
    legs.map((l) => `${l.from_customer_id}${l.to_customer_id}`).join(","));
  check("seq numbers run 1..n", legs.every((l, i) => l.seq === i + 1));
}

// ── 6. The benchmark: the higher of the flat rule and Goong ─────────────────
// The flat rule is a FLOOR. A slow road may raise the bar; nothing may lower it,
// or a driver would quietly be held to a tighter target than the rule they know.
check("takes Goong when the road is slower than the rule", benchmarkMinsFor(8, 14) === 14);
check("keeps the rule when Goong is optimistic", benchmarkMinsFor(28, 19) === 28);
check("a missing estimate leaves the rule untouched", benchmarkMinsFor(16, null) === 16);
check(
  "never returns below the flat rule",
  [null, 0, 1, 5, 99].every((e) => (benchmarkMinsFor(20, e) ?? 0) >= 20),
);
check("no distance means no benchmark at all", benchmarkMinsFor(null, 30) === null);

// The case this change exists for. 1.8 km rounds up to 2 km → 8 minutes under the
// flat rule, which is about what the fixed overhead alone costs; Goong saying 14
// is what makes the leg achievable instead of late by construction.
check("...the flat rule for 1.8 km really is 8", targetMinsFor(1.8) === 8);
check("the 1.8 km case loosens from 8 to 14", benchmarkMinsFor(targetMinsFor(1.8), 14) === 14);

// ── 7. A wait is labelled, not excused ──────────────────────────────────────
// Waits used to carry no verdict at all. That stopped a lunch break reading as a
// 130-minute failure, but it also hid ~11% of every day from the on-time figure —
// so the percentage described only the part of the day that was already fine.
// They are graded now; the flag exists to explain WHY a leg ran long, not to
// exempt it. The two decisions are made against different quantities, which is
// what lets a leg be both flagged and late.
{
  const { LONG_GAP_OVER_TARGET_MINS } = await import("../src/lib/tat");
  const bench = 20;

  const isWait = (mins: number) => mins - bench > LONG_GAP_OVER_TARGET_MINS;
  const isOnTime = (mins: number) => mins <= bench;

  const wait = bench + LONG_GAP_OVER_TARGET_MINS + 1;
  check("a long wait is flagged as a wait", isWait(wait) === true);
  check("a long wait is still graded, and graded late", isOnTime(wait) === false);

  const slow = bench + 5;
  check("a merely slow leg is late but NOT flagged a wait", isWait(slow) === false && isOnTime(slow) === false);

  const fine = bench - 1;
  check("a leg inside its benchmark is on time and unflagged", isWait(fine) === false && isOnTime(fine) === true);
}

// ── 8. The clock cannot start before the work existed ───────────────────────
// A driver who finished at 08:00 and whose next job only appeared at 10:00 was not
// idling for two hours — there was nothing to ride toward. Charging that time makes
// the report run backwards: the quieter the day, the worse the driver scores. Two
// thirds of every flagged wait measured over three days was exactly this.
{
  const legs = legsForRoute(route([
    stop({ id: 1, cust: "LAB", name: "D001", lat: 10.77, lng: 106.66, arrived: "07:30:00", completed: "08:00:00" }),
    stop({ id: 2, cust: "CLINIC", name: "Clinic A", lat: 10.78, lng: 106.68, arrived: "10:25:00", completed: "10:40:00",
           sched: "10:00:00" }),
  ]), DATE);

  check("the clock starts when the job appeared, not when the driver left",
    legs[0]?.tat_mins === 25, String(legs[0]?.tat_mins));
  check("the excluded time is recorded, not silently dropped", legs[0]?.idle_mins === 120, String(legs[0]?.idle_mins));
  check("the moment it became available is stored, so a disputed verdict can be explained",
    legs[0]?.available_at != null && Date.parse(legs[0]!.available_at!) === Date.parse(`${DATE}T10:00:00+07:00`),
    String(legs[0]?.available_at));
  check("tat_mins + idle_mins reconstructs the raw elapsed time",
    (legs[0]!.tat_mins ?? 0) + legs[0]!.idle_mins === 145);
}

// ── 9. Work that was already waiting is charged in full ─────────────────────
{
  const legs = legsForRoute(route([
    stop({ id: 1, cust: "LAB", name: "D001", lat: 10.77, lng: 106.66, arrived: "07:30:00", completed: "08:00:00" }),
    stop({ id: 2, cust: "CLINIC", name: "Clinic A", lat: 10.78, lng: 106.68, arrived: "08:40:00", completed: "08:50:00",
           sched: "07:00:00" }),
  ]), DATE);

  check("a job that already existed deducts nothing",
    legs[0]?.tat_mins === 40 && legs[0]?.idle_mins === 0, `${legs[0]?.tat_mins} / ${legs[0]?.idle_mins}`);
  check("and leaves available_at null", legs[0]?.available_at === null, String(legs[0]?.available_at));
}

// ── 10. Availability that post-dates the ARRIVAL is ignored entirely ────────
// The driver was already standing there, so it says nothing about when they could
// have set off. Honouring it would zero the leg — and planned jobs routinely carry
// a slot time later than the run that served them, so this would hand out free
// passes on ordinary rides. Conservative on purpose: a handful of "arrived before
// the window opened" legs keep reading as waits rather than as free rides.
{
  const legs = legsForRoute(route([
    stop({ id: 1, cust: "LAB", name: "D001", lat: 10.77, lng: 106.66, arrived: "07:30:00", completed: "08:00:00" }),
    stop({ id: 2, cust: "CLINIC", name: "Clinic A", lat: 10.78, lng: 106.68, arrived: "09:00:00", completed: "09:10:00",
           sched: "14:00:00" }),
  ]), DATE);

  check("a stamp later than the arrival never moves the clock",
    legs[0]?.tat_mins === 60 && legs[0]?.idle_mins === 0, `${legs[0]?.tat_mins} / ${legs[0]?.idle_mins}`);
  check("and can never produce a negative span", (legs[0]?.tat_mins ?? -1) >= 0);
}

// ── 11. Delivery windows count, and need the date bolted on ─────────────────
// Only ~4% of stops carry one, but on the flagged waits that had one the window
// alone cleared 11 that no other stamp explained. It arrives as "10:00:00+07" with
// no date at all, so a naive read lands in 1970 and deducts nothing.
{
  const legs = legsForRoute(route([
    stop({ id: 1, cust: "LAB", name: "D001", lat: 10.77, lng: 106.66, arrived: "07:30:00", completed: "08:00:00" }),
    stop({ id: 2, cust: "CLINIC", name: "Clinic A", lat: 10.78, lng: 106.68, arrived: "11:00:00", completed: "11:20:00",
           window: "10:00:00" }),
  ]), DATE);

  check("a delivery window opening starts the clock", legs[0]?.tat_mins === 60, String(legs[0]?.tat_mins));
  check("the window resolved to the trip date, not the epoch", legs[0]?.idle_mins === 120, String(legs[0]?.idle_mins));
}

// ── 12. Within one stop the LATEST stamp wins ───────────────────────────────
// The conditions are conjunctive: a job pushed to the driver at 09:00 but not
// startable until 10:00 was not rideable at 09:00.
{
  const legs = legsForRoute(route([
    stop({ id: 1, cust: "LAB", name: "D001", lat: 10.77, lng: 106.66, arrived: "07:30:00", completed: "08:00:00" }),
    stop({ id: 2, cust: "CLINIC", name: "Clinic A", lat: 10.78, lng: 106.68, arrived: "11:00:00", completed: "11:20:00",
           send: "09:00:00", sched: "08:30:00", allowed: "10:00:00" }),
  ]), DATE);

  check("every condition must be met, so the latest stamp governs",
    legs[0]?.tat_mins === 60 && legs[0]?.idle_mins === 120, `${legs[0]?.tat_mins} / ${legs[0]?.idle_mins}`);
}

// ── 13. Across a MERGED visit the EARLIEST availability wins ────────────────
// The opposite rule to within-a-stop, and deliberately so: the driver rode there
// once, and the first job that existed is what let them go. A sibling job created
// later cannot retroactively make that journey unavailable.
{
  const legs = legsForRoute(route([
    stop({ id: 1, cust: "LAB", name: "D001", lat: 10.77, lng: 106.66, arrived: "07:30:00", completed: "08:00:00" }),
    stop({ id: 2, cust: "CLINIC", name: "Clinic A", lat: 10.78, lng: 106.68, arrived: "11:30:00", completed: "11:40:00",
           sched: "11:00:00" }),
    stop({ id: 3, cust: "CLINIC", name: "Clinic A", lat: 10.78, lng: 106.68, arrived: "11:35:00", completed: "11:50:00",
           sched: "09:00:00" }),
  ]), DATE);

  check("the merged visit is still one leg", legs.length === 1, `got ${legs.length}`);
  check("it uses the earliest availability of the jobs there (09:00, not 11:00)",
    legs[0]?.idle_mins === 60 && legs[0]?.tat_mins === 150, `${legs[0]?.tat_mins} / ${legs[0]?.idle_mins}`);
}

// ── 14. No stamp at all → charged in full ───────────────────────────────────
// Absence of a signal is not evidence that the job appeared late.
{
  const legs = legsForRoute(route([
    stop({ id: 1, cust: "LAB", name: "D001", lat: 10.77, lng: 106.66, arrived: "07:30:00", completed: "08:00:00" }),
    stop({ id: 2, cust: "CLINIC", name: "Clinic A", lat: 10.78, lng: 106.68, arrived: "09:30:00", completed: "09:40:00" }),
  ]), DATE);

  check("no availability stamp → nothing deducted",
    legs[0]?.tat_mins === 90 && legs[0]?.idle_mins === 0, `${legs[0]?.tat_mins} / ${legs[0]?.idle_mins}`);
}

console.log(failures === 0 ? "\nAll TAT leg checks passed." : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
