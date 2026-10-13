/**
 * Samples on board: the customer clock (from THEIR pickup) and the driver clock
 * (from the driver's LAST tap) — see computeOnboardAlerts.
 *
 * The case worth pinning is the batch: a driver collecting at three clinics has
 * the first sample on board for a long time while working the whole time. The
 * customer may still need a call; the driver must NOT read as stalled.
 *
 *   npx tsx scripts/onboard-alert.test.mts
 */

const { computeOnboardAlerts } = await import("../src/lib/assign");

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const today = "2026-10-13";
const ts = (hhmm: string) => `${today} ${hhmm}:00`;
const now = (hhmm: string) => new Date(`${today}T${hhmm}:00+07:00`).getTime();

let nextId = 1;
/** One job: pickup collected at `picked` (or unstarted when null), drop-off open unless `arrived`. */
const job = (driver: string, picked: string | null, opts: { arrived?: string; status?: number } = {}) => ({
  job_id: nextId++,
  job_status_id: opts.status ?? 4,
  delivery_driver_id: driver,
  driver: { first_name: driver, last_name: "" },
  labels: [],
  stops: [
    { stop_type_id: 1, customer_name: `Clinic ${nextId}`, ...(picked ? { activity_started_ts: ts(picked), activity_arrived_ts: ts(picked), activity_completed_ts: ts(picked) } : {}) },
    { stop_type_id: 2, customer_name: "BRA - D001", ...(opts.arrived ? { activity_arrived_ts: ts(opts.arrived) } : {}) },
  ],
});

// 1. Batched driver: first pickup 09:00, still collecting (last tap 10:30). At 10:35
//    the 09:00 sample is 95 min on board → customer-late, but the driver is busy.
{
  const jobs = [job("A", "09:00"), job("A", "10:00"), job("A", "10:30")];
  const [a] = computeOnboardAlerts(jobs, today, now("10:35"));
  check("batch: first sample is customer-late", a?.late.length === 1 && a.late[0].job_id === jobs[0].job_id);
  check("batch: driver is not quiet", a?.quiet_since_ms === null);
}

// 2. Driver quiet: one sample on board since 10:00, nothing since. Quiet at 11:00
//    (60-min floor), with the unstarted pickup offered for another driver.
{
  const jobs = [job("B", "10:00"), job("B", null)];
  const at1059 = computeOnboardAlerts(jobs, today, now("10:59"));
  check("quiet: nothing at 59 min", at1059.length === 0);
  const [b] = computeOnboardAlerts(jobs, today, now("11:00"));
  check("quiet: flagged at 60 min", b?.quiet_since_ms === now("10:00"));
  check("quiet: unstarted pickup offered", b?.pending.length === 1 && b.pending[0].job_id === jobs[1].job_id);
  check("quiet: sample not yet customer-late (90 floor)", b?.late.length === 0);
}

// 3. Long ride: 40 km → target 160. Twice that would be 320 min; the cap holds it
//    to target + 60 = 220 (08:00 → 11:40). With no distance the floor applies
//    (superset pass).
{
  const jobs = [job("C", "08:00")];
  const km = (id: number) => (id === jobs[0].job_id ? 40 : null);
  check("long ride: quiet at 2h with distance", computeOnboardAlerts(jobs, today, now("10:00"), km).length === 0);
  check("long ride: nothing at 11:39", computeOnboardAlerts(jobs, today, now("11:39"), km).length === 0);
  const [c] = computeOnboardAlerts(jobs, today, now("11:40"), km);
  check("long ride: capped at target + 60, not 2×", c?.late.length === 1 && c.quiet_since_ms === now("08:00"));
  check("long ride: superset pass flags it without distance", computeOnboardAlerts(jobs, today, now("10:00")).length === 1);
}

// 4. Arrival ends it; another day's pickup is not today's evidence.
{
  const arrived = [job("D", "08:00", { arrived: "08:30" })];
  check("arrived at drop-off: nothing", computeOnboardAlerts(arrived, today, now("12:00")).length === 0);
  const rolled = job("E", null);
  (rolled.stops[0] as Record<string, unknown>).activity_completed_ts = "2026-10-12 17:00:00";
  check("pickup from yesterday: nothing", computeOnboardAlerts([rolled], today, now("12:00")).length === 0);
}

// 5. A completed job's later tap keeps the driver un-quiet (status 5 is evidence).
{
  const done = job("F", "10:50", { arrived: "11:10", status: 5 });
  const jobs = [job("F", "10:00"), done];
  const [f] = computeOnboardAlerts(jobs, today, now("11:30"));
  check("completed job's tap counts as activity", f === undefined || f.quiet_since_ms === null);
}

// 6. Ignored staff codes never alert, however late.
{
  const ignored = job("x", "06:00");
  ignored.driver = { first_name: "F - C - DC100993 Nguyễn Hồng Sơn", last_name: "" };
  check("ignored driver: nothing", computeOnboardAlerts([ignored], today, now("12:00")).length === 0);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall ok");
process.exit(failures ? 1 : 0);
