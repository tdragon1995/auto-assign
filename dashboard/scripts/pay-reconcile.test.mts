/**
 * Payroll reconciliation: the diff, the distance-retention rule, paging, and the
 * Tuấn regression figure.
 *
 *   npx tsx scripts/pay-reconcile.test.mts
 */
import { diffPayDay, keepStoredDistances, type DayInput } from "../src/lib/pay-reconcile";
import { payRowsForRoute, kmPayFor, workedMinutes, type PayJob, type PayPunch } from "../src/lib/pay";
import { payrollPeriod } from "../src/lib/pay-period";
import { sbSelectAll } from "../src/lib/supabase-rest";
import type { Job, TimelineRoute, TimelineStop } from "../src/lib/types";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const DAY = "2026-08-20";
const TUAN = "f5d3248a-eb7c-11f0-94e2-506b8d982279";
const TUAN_NAME = "BRA - D018 - PT101690 Lâm Sơn Tuấn";

const job = (id: number, driver = TUAN, name = TUAN_NAME, km: number | null = 3.9, lat = 10.77): PayJob => ({
  trip_date: DAY, driver_id: driver, driver_name: name, job_id: id, reference_number: `R${id}`,
  pickup_customer_id: "D018", pickup_name: "BRA - D018", pickup_lat: lat, pickup_lng: 106.66, pickup_completed_ts: `${DAY}T08:00:00+07:00`,
  dropoff_customer_id: "D001", dropoff_name: "BRA - D001", dropoff_lat: 10.76, dropoff_lng: 106.67, dropoff_completed_ts: `${DAY}T08:20:00+07:00`,
  distance_km: km,
});
const punch = (id: number, kind: "in" | "out", hhmm: string, driver = TUAN): PayPunch => ({
  trip_date: DAY, driver_id: driver, driver_name: TUAN_NAME, job_id: id, kind, customer_id: null, location_name: null,
  started_ts: null, arrived_ts: null, completed_ts: `${DAY}T${hhmm}:00+07:00`, job_status_id: 5,
});
const rest = (id: number, driver = TUAN): Job => ({
  job_id: id, job_status_id: 5, delivery_driver_id: driver, reference_number: `R${id}`,
  stops: [{ stop_type_id: 1 }, { stop_type_id: 2 }],
} as unknown as Job);
const input = (over: Partial<DayInput> = {}): DayInput => ({
  date: DAY, routes: [], restCompleted: [], stored: { jobs: [], punches: [] }, otherDates: [], ...over,
});

console.log("\n1. Tuấn regression — 12 jobs at the verified 3.9 km");
{
  const jobs = Array.from({ length: 12 }, (_, i) => job(1000 + i));
  const km = Math.round(jobs.reduce((s, j) => s + (j.distance_km ?? 0), 0) * 100) / 100;
  check("46.8 km", km === 46.8, String(km));
  check("93,600đ mileage pay", kmPayFor(km) === 93_600, String(kmPayFor(km)));
  const r = diffPayDay(input({ restCompleted: jobs.map((j) => rest(j.job_id)) }), jobs, [], new Map());
  check("all 12 are missing from an empty store", r.diff.missing_jobs.length === 12);
  check("PT totals after = 46.8 km", r.totals.after.km === 46.8 && r.totals.after.jobs === 12, JSON.stringify(r.totals.after));
  check("no exceptions when REST agrees", r.exceptions.length === 0, JSON.stringify(r.exceptions));
}

console.log("\n2. Period boundaries");
{
  const { from, to } = payrollPeriod("2026-09");
  check("15 Aug included, 14 Sep included", from === "2026-08-15" && to === "2026-09-14");
  check("14 Aug and 15 Sep excluded", !("2026-08-14" >= from) && !("2026-09-15" <= to));
}

console.log("\n3. Repeat execution is a no-op");
{
  const jobs = [job(1), job(2)];
  const punches = [punch(9, "in", "07:00"), punch(10, "out", "11:00")];
  const stored = { jobs: jobs.map((j) => ({ ...j, distance_km: String(j.distance_km) as unknown as number, id: 1 })), punches: punches.map((p) => ({ ...p, completed_ts: new Date(p.completed_ts!).toISOString() })) };
  const a = diffPayDay(input({ stored, restCompleted: [rest(1), rest(2)] }), jobs, punches, new Map());
  const b = diffPayDay(input({ stored, restCompleted: [rest(1), rest(2)] }), jobs.map((j) => ({ ...j })), [...punches], new Map());
  check("nothing missing/changed/extra once stored", a.diff.missing_jobs.length + a.diff.changed_jobs.length + a.diff.extra_jobs.length + a.diff.missing_punches + a.diff.changed_punches + a.diff.extra_punches.length === 0, JSON.stringify(a.diff));
  check("digest is stable", a.digest === b.digest);
  check("before equals after", JSON.stringify(a.totals.before) === JSON.stringify(a.totals.after));
}

console.log("\n4. Duplicates and account separation");
{
  const DC = "dc-account"; const DC_NAME = "BRA - D018 - DC100001 Lâm Sơn Tuấn";
  const r = diffPayDay(
    input({ restCompleted: [rest(5, DC), rest(6)] }),
    [job(5, TUAN), job(5, DC, DC_NAME), job(6), job(7, TUAN), job(7, DC, DC_NAME)],
    [], new Map(),
  );
  check("REST owner resolves a two-route job", r.write.jobs.filter((j) => j.job_id === 5).length === 1 && r.write.jobs.find((j) => j.job_id === 5)!.driver_id === DC);
  check("unresolvable duplicate is held out AND listed", !r.write.jobs.some((j) => j.job_id === 7) && r.exceptions.some((e) => e.kind === "job_duplicate_unresolved" && e.job_id === 7));
  check("FT twin is not in PT totals", r.totals.after.jobs === 1, JSON.stringify(r.totals.after));
  check("timeline-only job flagged", r.exceptions.some((e) => e.kind === "timeline_only_job" && e.job_id === 7));
}

console.log("\n5. Distances: stored figure kept, never replaced by a failure");
{
  const stored = [{ ...job(1), distance_km: "3.90" as unknown as number }, job(2, TUAN, TUAN_NAME, 5)];
  const fresh = [job(1, TUAN, TUAN_NAME, null), job(2, TUAN, TUAN_NAME, null, 10.9), job(3, TUAN, TUAN_NAME, null)];
  const kept = keepStoredDistances(fresh, stored);
  check("same pair keeps stored km", fresh[0].distance_km === 3.9 && kept === 1);
  check("different coordinates do not inherit", fresh[1].distance_km === null);
  const noCoords = { ...job(4, TUAN, TUAN_NAME, null), pickup_lat: null };
  const r = diffPayDay(input({ restCompleted: [rest(3), rest(4)] }), [fresh[2], noCoords], [], new Map());
  check("unpriced job is an exception", r.exceptions.some((e) => e.kind === "job_unpriced" && e.job_id === 3));
  check("missing coordinates is an exception", r.exceptions.some((e) => e.kind === "job_missing_coordinates" && e.job_id === 4));
}

console.log("\n6. Attendance exceptions — nothing invented");
{
  const punches = [punch(1, "in", "06:00"), punch(2, "out", "10:00"), punch(3, "in", "15:00"), punch(4, "out", "05:00")];
  const w = workedMinutes(punches);
  check("orphan clock-out pays nothing", w.minutes === 0 + 240 && w.stray_out.length === 1, JSON.stringify(w));
  const r = diffPayDay(input(), [], punches, new Map());
  check("open check-in listed", r.exceptions.some((e) => e.kind === "attendance_open_in"));
  check("stray check-out listed", r.exceptions.some((e) => e.kind === "attendance_stray_out"));
  check("REST-only job flagged, not dropped silently", diffPayDay(input({ restCompleted: [rest(77)] }), [], [], new Map()).exceptions.some((e) => e.kind === "rest_only_job"));
}

console.log("\n6b. Jobs excluded by the pay rule are not cross-check misses");
{
  const ret = { ...rest(501), labels: ["🛵 Vận chuyển mẫu PSC (về)"] } as Job;
  const r = diffPayDay(input({ restCompleted: [ret, rest(502), rest(503)], ineligible: new Set([502]) }), [], [], new Map());
  const flagged = r.exceptions.filter((e) => e.kind === "rest_only_job").map((e) => e.job_id);
  check("return-labelled REST job not flagged", !flagged.includes(501));
  check("timeline-ineligible job not flagged", !flagged.includes(502));
  check("a genuinely unpaid job still is", flagged.includes(503), JSON.stringify(flagged));
}

console.log("\n6c. An apply writes only the rows that differ");
{
  const same = job(1);
  const moved = job(2, TUAN, TUAN_NAME, 9.9);
  const stored = {
    jobs: [{ ...same }, { ...job(2) }],   // job 2 stored with the OLD distance
    punches: [] as never[],
  };
  const r = diffPayDay(input({ stored, restCompleted: [rest(1), rest(2), rest(3)] }), [same, moved, job(3)], [], new Map());
  const delta = r.writeDelta.jobs.map((j) => j.job_id).sort();
  check("unchanged row is not rewritten", !delta.includes(1));
  check("changed row is written", delta.includes(2));
  check("missing row is written", delta.includes(3), JSON.stringify(delta));
  check("the full set still reports 3", r.write.jobs.length === 3);
}

console.log("\n6d. Without the cross-check there are no REST exceptions");
{
  const r = diffPayDay(input({ restCompleted: [] }), [job(1)], [], new Map());
  check("no timeline-only noise when REST was not fetched",
    !r.exceptions.some((e) => e.kind === "timeline_only_job"), JSON.stringify(r.exceptions));
  check("the job is still proposed", r.write.jobs.length === 1);
}

console.log("\n7. Extras are reported, not deleted");
{
  const r = diffPayDay(input({ stored: { jobs: [job(99)], punches: [punch(98, "in", "07:00")] } }), [], [], new Map());
  check("extra job listed", r.diff.extra_jobs.length === 1 && r.diff.extra_jobs[0].job_id === 99);
  check("extra punch listed", r.diff.extra_punches.length === 1);
  check("write carries nothing to delete", r.write.jobs.length === 0);
}

console.log("\n8. Timeline rows → pay rows keep tracking-free job identity");
{
  const stop = (o: Partial<TimelineStop>) => ({ jobStatusId: 5, customerName: "x", latitude: 10, longitude: 106, activityCompletedTs: `${DAY} 08:00:00`, ...o }) as TimelineStop;
  const route = { routeId: `driver_${TUAN}`, driverFullname: TUAN_NAME, orderedStops: [stop({ jobId: 1, stopTypeId: 1 }), stop({ jobId: 1, stopTypeId: 2 })] } as unknown as TimelineRoute;
  check("one pickup→dropoff job", payRowsForRoute(route, DAY).jobs.length === 1);
}

console.log("\n9. Paging beyond 1,000 rows");
{
  process.env.SUPABASE_URL = "http://sb.test"; process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
  const all = Array.from({ length: 2345 }, (_, i) => ({ id: i }));
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url); seen.push(u.search);
    const off = Number(u.searchParams.get("offset")); const lim = Number(u.searchParams.get("limit"));
    return new Response(JSON.stringify(all.slice(off, off + lim)), { status: 200 });
  }) as typeof fetch;
  const rows = await sbSelectAll<{ id: number }>("pay_punches", "select=*", "id.asc");
  check("all 2,345 rows read", rows.length === 2345 && rows[2344].id === 2344);
  check("every page carries the stable order", seen.every((s) => s.includes("order=id.asc")) && seen.length === 3);
  let threw = false;
  try { await sbSelectAll("pay_jobs", "select=*", ""); } catch { threw = true; }
  check("refuses to page without an order", threw);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
