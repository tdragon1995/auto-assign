/**
 * What it would COST to refresh the late-pickup list on every cycle, and whether
 * the stale-window guard that drives that cost is earning its keep.
 *
 * Two decisions wait on these numbers.
 *
 *  1. RUN THE LATE CHECK ON EVERY CYCLE? Today it only runs on cycles that had a
 *     job to assign (assign.ts, the `jobs.length === 0` exit), so on a quiet fleet
 *     the list freezes and a collected pickup clears by 10-minute expiry rather
 *     than because anyone noticed. Moving it costs Cartrack calls, because
 *     dropStaleWindowWarnings fetches job details for every windowed pickup past
 *     the 2-hour mark. This prints that bill.
 *
 *  2. KEEP THE STALE-WINDOW GUARD AT ALL? It exists for one recorded incident
 *     (job 34421121: booked 19:48 for an 08:00-09:05 window, born ~12h overdue,
 *     pinged the supervisor group seconds after the client booked). Nobody has
 *     since measured whether that is a daily event or a yearly one. If it is rare,
 *     the cheap fix is a per-job-per-day memo; if it is common, the right fix is
 *     capturing the real booking time once when a job first appears.
 *
 * METHOD, and its honest limits. Cartrack gives final state, not history, so a
 * cycle is RECONSTRUCTED: a pickup counts as untouched at time T when its earliest
 * activity stamp is absent or later than T, and the fleet counts as busy at T when
 * some job was created before T and assigned after it. Both are approximations.
 * The fetch count is therefore an UPPER BOUND — the real cycle also drops warnings
 * for a driver who is busy elsewhere or just finished a stop nearby, and those only
 * ever remove suspects. Read it as "no worse than".
 *
 * Read-only: it fetches days and prints. It drops the Redis credentials before
 * loading any app code, so it cannot touch live dashboard state.
 *
 *   cd dashboard && npx tsx scripts/late-check-cost-live.mts --days=30
 *   cd dashboard && npx tsx scripts/late-check-cost-live.mts --days=60 --env=prod
 *
 * --fixture=<file> reads one day from a saved `GET /jobs` response instead of the
 * API. No credentials, no network — it is how the arithmetic below was checked
 * before anyone spent a Cartrack call on it, and it is worth re-running after any
 * edit to that arithmetic.
 *
 *   cd dashboard && npx tsx scripts/late-check-cost-live.mts --fixture=../response.json
 */

import { readFileSync } from "node:fs";

const FIXTURE = process.argv.find((a) => a.startsWith("--fixture="))?.split("=")[1];

if (!FIXTURE) for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
// Never read or write live dashboard state while reporting on it.
// (Unconditional: the fixture path must not touch it either.)
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const { getJobsByDate } = await import("../src/lib/cartrack");
const { isStaleWindow, isInternalOrPlanJob, parsePickupWindowTime } = await import("../src/lib/assign");
const { vnDate, addDays, parseVnTimestamp } = await import("../src/lib/time");

const arg = (name: string, dflt: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : dflt;
};
const DAYS = arg("days", 30);
const ENV = (process.argv.find((a) => a.startsWith("--env="))?.split("=")[1] ?? "prod") as "prod" | "uat";

// Mirrors of the production constants this measurement depends on. Kept as literals
// so a change there shows up here as a discrepancy to explain rather than silently
// moving the answer.
// PICKUP_OVERDUE_MIN is 90; it does not appear below because a suspect is defined by
// elapsed ≥ ALERT_MIN (minutes_late + 90 ≥ 120), which cancels it out.
const ALERT_MIN = 120;       // LATE_ALERT_MIN — the mark that makes a warning a "suspect"
const CLOCK_START = 7 * 60;  // PICKUP_CLOCK_START 07:00
const ARM_FROM = 5 * 60 + 30;
const ARM_TO = 22 * 60;
const CYCLE_MIN = 3;

/** Only the fields this measurement reads. Cartrack's job rows carry many more. */
type RawStop = {
  stop_type_id?: number;
  delivery_windows?: { time_from?: string }[];
  activity_started_ts?: string | null;
  activity_arrived_ts?: string | null;
  activity_completed_ts?: string | null;
};
type RawJob = {
  job_id?: number;
  create_ts?: string;
  scheduled_delivery_ts?: string | null;
  stops?: RawStop[];
};

const MS = 60_000;
const minsInto = (day: string, d: Date) => (d.getTime() - new Date(`${day}T00:00:00+07:00`).getTime()) / MS;
const stampMins = (day: string, ts?: string | null): number | null => {
  if (!ts) return null;
  const t = parseVnTimestamp(ts);
  return isNaN(t.getTime()) ? null : minsInto(day, t);
};

type DayRow = {
  day: string; jobs: number; windowed: number; stale: number; fetchesEvery: number;
};
const rows: DayRow[] = [];
const staleExamples: string[] = [];

// One saved day, or the last DAYS days from the API.
const days: string[] = FIXTURE
  ? []
  : Array.from({ length: DAYS }, (_, k) => addDays(vnDate(), -(DAYS - k)));
const fixtureJobs: RawJob[] = FIXTURE ? (JSON.parse(readFileSync(FIXTURE, "utf8")).data ?? []) : [];
if (FIXTURE) {
  // Date the fixture by its own contents, so the window/clock arithmetic lands on
  // the day those jobs were actually scheduled for.
  const d = fixtureJobs.find((j) => j.scheduled_delivery_ts)?.scheduled_delivery_ts?.slice(0, 10);
  if (!d) { console.error("fixture has no scheduled_delivery_ts to date it by"); process.exit(1); }
  days.push(d);
  console.log(`fixture: ${FIXTURE} → ${fixtureJobs.length} jobs dated ${d}\n`);
}

for (const day of days) {
  let jobs: RawJob[] = [];
  try {
    jobs = FIXTURE ? fixtureJobs : ((await getJobsByDate(day, ENV)) as unknown as RawJob[]);
  } catch (e) {
    console.log(`${day}  FETCH FAILED — ${e}`);
    continue;
  }

  // NO "how many cycles were quiet" ESTIMATE HERE, deliberately. The obvious one —
  // a job is unassigned between create_ts and assigned_ts — does not survive contact
  // with the data: assigned_ts is populated on well under half of jobs (309/738 in
  // the payload this was checked against), so every job missing it reads as
  // unassigned until 22:00 and marks the whole day busy. That inflated the "today"
  // figure until it equalled the every-cycle one and reported the change as free,
  // which is exactly the wrong answer to hand someone.
  //
  // The quiet fraction is recorded elsewhere and exactly: the engine logs
  // "No unassigned jobs" on every quiet cycle. Count those lines over a day (the
  // dashboard's Nhật ký tab, or the run log in Redis) and multiply.

  let windowed = 0, stale = 0, fetchesEvery = 0;
  for (const j of jobs) {
    if (isInternalOrPlanJob(j as Parameters<typeof isInternalOrPlanJob>[0])) continue;
    const pickup = (j.stops ?? []).find((s) => s.stop_type_id === 1);
    const from = pickup?.delivery_windows?.[0]?.time_from;
    if (!from) continue;
    const ws = parsePickupWindowTime(from, day);
    if (!ws || isNaN(ws.getTime())) continue;
    windowed++;

    if (isStaleWindow(from, day, j.create_ts)) {
      stale++;
      if (staleExamples.length < 12) {
        staleExamples.push(`  job ${j.job_id}  window ${from.slice(0, 5)}  booked ${j.create_ts}`);
      }
    }

    // The clock the engine would run: window start, floored at 07:00.
    const clockFrom = Math.max(minsInto(day, ws), CLOCK_START);
    // Suspect once elapsed ≥ ALERT_MIN (minutes_late + OVERDUE_MIN ≥ ALERT_MIN).
    const suspectFrom = clockFrom + ALERT_MIN;
    // Untouched until the earliest activity stamp of any kind.
    const touched = [pickup.activity_started_ts, pickup.activity_arrived_ts, pickup.activity_completed_ts]
      .map((t) => stampMins(day, t)).filter((n): n is number => n != null);
    const suspectTo = touched.length ? Math.min(...touched) : ARM_TO;

    for (let t = Math.max(suspectFrom, ARM_FROM); t < Math.min(suspectTo, ARM_TO); t += CYCLE_MIN) {
      fetchesEvery++;
    }
  }
  rows.push({ day, jobs: jobs.length, windowed, stale, fetchesEvery });
  console.log(`${day}  jobs ${String(jobs.length).padStart(4)}  windowed ${String(windowed).padStart(3)}  stale ${String(stale).padStart(2)}  every-cycle fetches~${String(fetchesEvery).padStart(4)}`);
}

const sum = (f: (r: DayRow) => number) => rows.reduce((a, r) => a + f(r), 0);
const n = rows.length || 1;

console.log(`\n${"=".repeat(72)}`);
console.log(`${rows.length} day(s), ${sum((r) => r.jobs)} jobs\n`);

console.log(`DECISION 2 — is the stale-window guard worth keeping?`);
console.log(`  windowed pickups     : ${sum((r) => r.windowed)}  (${(sum((r) => r.windowed) / n).toFixed(1)}/day)`);
console.log(`  genuinely stale      : ${sum((r) => r.stale)}  (${(sum((r) => r.stale) / n).toFixed(2)}/day)`);
console.log(`  → each one is a false "trễ ~Xh" push the guard prevented.`);
if (staleExamples.length) console.log(staleExamples.join("\n"));
else console.log(`  → NONE in this window. The guard prevented nothing here; weigh that against`);
if (!staleExamples.length) console.log(`    the fetches below before keeping it on the per-cycle path.`);

const every = sum((r) => r.fetchesEvery) / n;
console.log(`\nDECISION 1 — cost of refreshing the late list every cycle`);
console.log(`  if EVERY cycle ran the check : ~${every.toFixed(0)} detail fetches/day (upper bound)`);
console.log(`  the change ADDS              : that figure × the share of cycles that are quiet`);
console.log(`\n  This script will not guess that share — see the note in the day loop. Count`);
console.log(`  "No unassigned jobs" lines in one day's run log (Nhật ký tab) and multiply.`);
console.log(`  Upper bound is the whole ~${every.toFixed(0)}/day, if the fleet were quiet all day.`);
console.log(`\n  A per-job-per-day memo collapses this to at most one fetch per windowed`);
console.log(`  2h+ pickup per day — the "windowed" row's scale, not the fetch row's.`);
if (FIXTURE) {
  console.log(`\n  ⚠ FIXTURE RUN. A saved payload is a point-in-time snapshot: pickups touched`);
  console.log(`    after capture still read as untouched, so the fetch figure is inflated and`);
  console.log(`    is NOT a real day. Use it to check the arithmetic, not to decide.`);
}
console.log(`${"=".repeat(72)}`);
