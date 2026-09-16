/**
 * Payroll-only reconciliation. Dry-run is the default and never writes payroll
 * tables. Apply mode consumes the exact proposal produced by a reviewed dry run:
 *
 *   npm run payroll:reconcile -- --month=2026-09
 *   npm run payroll:reconcile -- --apply=payroll-audits/2026-09/<run>/proposal.json --confirm=APPLY-2026-09
 *
 * Run in an already-authorized environment. This script never downloads or
 * prints credentials. Full backups and proposals are sensitive and gitignored.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { getJobsByStatusAndDate, getTimelineRoutes } from "../src/lib/cartrack";
import { employmentOf } from "../src/lib/driver-label";
import { isChamCong } from "../src/lib/job-filters";
import { attachPayDistances, payRowsForRoute, workedMinutes, type PayJob, type PayPunch } from "../src/lib/pay";
import { payrollPeriod } from "../src/lib/pay-period";
import {
  diffPayRows, onlyPartTime, payrollDays, summarizeDrivers,
  type StoredPayJob, type StoredPayPunch,
} from "../src/lib/payroll-reconcile";
import { setPayrollCoverage, type PayrollCoverage } from "../src/lib/payroll-coverage";
import { sbDelete, sbSelectAll, sbUpsert, missingSupabaseEnv } from "../src/lib/supabase-rest";
import type { Job, TimelineRoute } from "../src/lib/types";
import { vnDate } from "../src/lib/time";
import { encryptAudit } from "./payroll-audit-crypto";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.length ? rest.join("=") : "true"];
}));
const month = args.get("month") ?? "2026-09";
const applyPath = args.get("apply") === "true" ? null : args.get("apply");
const rollbackDir = args.get("rollback") === "true" ? null : args.get("rollback");
const confirm = args.get("confirm") ?? "";
const deleteListPath = args.get("delete-list");
const baselinePath = args.get("baseline");
const capturePath = args.get("capture-baseline");
const recipientPath = args.get("recipient");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("--month must be YYYY-MM");
const missingEnv = [
  ...(!baselinePath || applyPath || rollbackDir || capturePath ? missingSupabaseEnv() : []),
  ...(!applyPath && !rollbackDir && !capturePath && !process.env.CARTRACK_WEB_PASS ? ["CARTRACK_WEB_PASS"] : []),
  ...(!applyPath && !rollbackDir && !capturePath && !process.env.CARTRACK_AUTH ? ["CARTRACK_AUTH"] : []),
  ...((applyPath || rollbackDir) && !(process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL) ? ["KV_REST_API_URL"] : []),
  ...((applyPath || rollbackDir) && !(process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN) ? ["KV_REST_API_TOKEN"] : []),
];
if (missingEnv.length) throw new Error(`Run in an authorized environment; missing ${missingEnv.join(", ")}`);

const writePrivateJson = (path: string, value: unknown) => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
};

async function selectStored(from: string, to: string) {
  const [jobs, punches] = await Promise.all([
    sbSelectAll<StoredPayJob>("pay_jobs", `select=*&trip_date=gte.${from}&trip_date=lte.${to}&order=trip_date.asc,job_id.asc`),
    sbSelectAll<StoredPayPunch>("pay_punches", `select=*&trip_date=gte.${from}&trip_date=lte.${to}&order=trip_date.asc,job_id.asc`),
  ]);
  return { jobs, punches };
}

// Include an incorrectly stored full-time assignment when a verified source job
// belongs to a PT account. Unrelated full-time records stay outside corrections.
function relevantRows<T extends { job_id: number; driver_name: string | null }>(stored: T[], expected: T[]): T[] {
  const ids = new Set(expected.map((row) => row.job_id));
  return stored.filter((row) => ids.has(row.job_id) || employmentOf(row.driver_name) === "part-time");
}

async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await fn(); } catch (error) {
      last = error;
      if (attempt < 3) await sleep(attempt * 1000);
    }
  }
  throw new Error(`${label}: ${last instanceof Error ? last.message : String(last)}`);
}

const driverNameOf = (job: Job) => `${job.driver?.first_name ?? ""} ${job.driver?.last_name ?? ""}`.trim();
const paidRestJobs = (jobs: Job[]) => jobs.filter((job) =>
  job.job_status_id === 5 && employmentOf(driverNameOf(job)) === "part-time" &&
  job.stops.some((stop) => stop.stop_type_id === 1) && job.stops.some((stop) => stop.stop_type_id === 2));

const trackingByJob = (routes: TimelineRoute[]) => {
  const out = new Map<string, Array<{ job_id: number; driver_name: string | null }>>();
  for (const route of routes) {
    const name = (route as TimelineRoute & { driverFullname?: string | null }).driverFullname ?? null;
    for (const stop of route.orderedStops ?? []) {
      for (const tracking of stop.itemTrackingNumbers ?? []) {
        const list = out.get(tracking) ?? [];
        const job_id = Number(stop.jobId);
        if (!list.some((match) => match.job_id === job_id && match.driver_name === name)) list.push({ job_id, driver_name: name });
        out.set(tracking, list);
      }
    }
  }
  return out;
};

interface DaySource {
  date: string;
  jobs: PayJob[];
  punches: PayPunch[];
  timeline_job_ids: number[];
  rest_job_ids: number[];
  rest_punch_ids: number[];
  tracking: Record<string, Array<{ job_id: number; driver_name: string | null }>>;
  source_exceptions: string[];
}

interface Proposal {
  version: 1;
  mode: "dry-run";
  report_id: string;
  month: string;
  from: string;
  to: string;
  created_at: string;
  failed_days: Array<{ date: string; error: string }>;
  source_exceptions: string[];
  attendance_exceptions: number;
  jobs: PayJob[];
  punches: PayPunch[];
  deletions: { jobs: Array<{ trip_date: string; job_id: number }>; punches: Array<{ trip_date: string; job_id: number }> };
}

function validateProposal(proposal: Proposal) {
  if (proposal.version !== 1 || proposal.mode !== "dry-run" ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(proposal.month)) throw new Error("Unsupported proposal file");
  const period = payrollPeriod(proposal.month);
  if (proposal.from !== period.from || proposal.to !== period.to) throw new Error("Proposal period differs from payroll rules");
  const dates = new Set(payrollDays(period.from, period.to));
  for (const row of [...proposal.jobs, ...proposal.punches]) {
    if (!dates.has(row.trip_date) || !Number.isSafeInteger(row.job_id) || row.job_id <= 0 ||
        !row.driver_id || employmentOf(row.driver_name) !== "part-time") throw new Error("Proposal contains an invalid payroll row");
  }
  for (const row of proposal.jobs) if (row.distance_km != null &&
      (!Number.isFinite(row.distance_km) || row.distance_km < 0)) throw new Error("Proposal contains an invalid distance");
  if (diffPayRows(proposal.jobs, []).duplicates.length || diffPayRows(proposal.punches, []).duplicates.length) {
    throw new Error("Proposal contains duplicate rows");
  }
  const exceptions = summarizeDrivers(proposal.jobs, proposal.punches).reduce((sum, row) => sum + row.open_in + row.stray_out, 0);
  if (exceptions !== proposal.attendance_exceptions) throw new Error("Proposal attendance exception count differs from raw punches");
  for (const row of [...proposal.deletions.jobs, ...proposal.deletions.punches]) {
    if (!dates.has(row.trip_date) || !Number.isSafeInteger(row.job_id) || row.job_id <= 0) throw new Error("Proposal contains an invalid deletion");
  }
}

async function dryRun() {
  const { from, to } = payrollPeriod(month);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = resolve(args.get("out-dir") ?? `payroll-audits/${month}/${stamp}`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const baseline = baselinePath ? JSON.parse(readFileSync(resolve(baselinePath), "utf8")) as {
    from: string; to: string; captured_at: string; jobs: StoredPayJob[]; punches: StoredPayPunch[];
  } : { from, to, captured_at: new Date().toISOString(), ...await selectStored(from, to) };
  if (baselinePath && (baseline.from !== from || baseline.to !== to)) throw new Error("Baseline period differs from requested payroll period");
  writePrivateJson(resolve(runDir, "baseline.json"), { ...baseline, month });

  const sources: DaySource[] = [];
  const failed_days: Proposal["failed_days"] = [];
  for (const date of payrollDays(from, to)) {
    try {
      const routes = await retry(`timeline ${date}`, async () => {
        const result = await getTimelineRoutes(date, "prod");
        if (!result) throw new Error("Cartrack timeline returned no result");
        return result;
      });
      const rest = await retry(`REST completed jobs ${date}`, () => getJobsByStatusAndDate(5, date, "prod", { strictPagination: true }));
      writePrivateJson(resolve(runDir, `source-${date}.json`), { date, routes, completed_rest: rest });
      const jobs: PayJob[] = [];
      const punches: PayPunch[] = [];
      const unclassified: string[] = [];
      for (const route of routes) {
        const rows = payRowsForRoute(route, date);
        for (const row of [...rows.jobs, ...rows.punches]) if (!employmentOf(row.driver_name)) {
          unclassified.push(`timeline job/punch ${row.job_id} has no recognizable driver account`);
        }
        jobs.push(...onlyPartTime(rows.jobs));
        punches.push(...onlyPartTime(rows.punches));
      }
      const restPaid = paidRestJobs(rest);
      const timelineIds = [...new Set(jobs.map((job) => job.job_id))].sort((a, b) => a - b);
      const restIds = [...new Set(restPaid.map((job) => job.job_id))].sort((a, b) => a - b);
      const timelinePunchIds = [...new Set(punches.filter((row) => row.job_status_id === 5).map((row) => row.job_id))].sort((a, b) => a - b);
      const restPunchIds = [...new Set(rest
        .filter((job) => isChamCong(job) && employmentOf(driverNameOf(job)) === "part-time")
        .map((job) => job.job_id))].sort((a, b) => a - b);
      const timelineSet = new Set(timelineIds);
      const restSet = new Set(restIds);
      const timelinePunchSet = new Set(timelinePunchIds);
      const restPunchSet = new Set(restPunchIds);
      const restById = new Map(restPaid.map((job) => [job.job_id, job]));
      const restAllById = new Map(rest.map((job) => [job.job_id, job]));
      const source_exceptions = [
        ...unclassified,
        ...rest.filter((job) => !employmentOf(driverNameOf(job)) && (isChamCong(job) ||
          (job.stops.some((stop) => stop.stop_type_id === 1) && job.stops.some((stop) => stop.stop_type_id === 2))))
          .map((job) => `REST job/punch ${job.job_id} has no recognizable driver account`),
        ...timelineIds.filter((id) => !restSet.has(id)).map((id) => `job ${id} is in timeline but not completed REST`),
        ...restIds.filter((id) => !timelineSet.has(id)).map((id) => `job ${id} is in completed REST but not timeline`),
        ...timelinePunchIds.filter((id) => !restPunchSet.has(id)).map((id) => `punch ${id} is completed in timeline but not completed REST`),
        ...restPunchIds.filter((id) => !timelinePunchSet.has(id)).map((id) => `punch ${id} is in completed REST but not timeline`),
        ...jobs.flatMap((job) => {
          const restJob = restById.get(job.job_id);
          if (!restJob) return [];
          const restDriver = restJob.delivery_driver_id ?? restJob.driver?.delivery_driver_id ?? "";
          return restDriver !== job.driver_id
            ? [`job ${job.job_id} driver differs: timeline ${job.driver_id}, REST ${restDriver}`]
            : [];
        }),
        ...punches.flatMap((punch) => {
          const restJob = restAllById.get(punch.job_id);
          if (!restJob) return [];
          const restDriver = restJob.delivery_driver_id ?? restJob.driver?.delivery_driver_id ?? "";
          return restDriver !== punch.driver_id
            ? [`punch ${punch.job_id} driver differs: timeline ${punch.driver_id}, REST ${restDriver}`] : [];
        }),
        ...jobs.filter((job) => [job.pickup_completed_ts, job.dropoff_completed_ts].some((ts) => ts &&
          vnDate(new Date(ts)) !== date))
          .map((job) => `job ${job.job_id} completion crosses its scheduled day; review attribution`),
        ...punches.filter((punch) => [punch.started_ts, punch.arrived_ts, punch.completed_ts].some((ts) => ts &&
          vnDate(new Date(ts)) !== date))
          .map((punch) => `punch ${punch.job_id} activity crosses its scheduled day; review attribution`),
      ];
      sources.push({
        date, jobs, punches, timeline_job_ids: timelineIds, rest_job_ids: restIds, rest_punch_ids: restPunchIds,
        tracking: Object.fromEntries(trackingByJob(routes)), source_exceptions,
      });
      process.stdout.write(`read ${date}: ${jobs.length} PT jobs, ${punches.length} punches, ${source_exceptions.length} source exceptions\n`);
      await sleep(250);
    } catch (error) {
      failed_days.push({ date, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const expectedJobs = sources.flatMap((day) => day.jobs);
  const expectedPunches = sources.flatMap((day) => day.punches);
  const storedByKey = new Map(baseline.jobs.map((job) => [`${job.trip_date}:${job.job_id}`, job]));
  for (const job of expectedJobs) {
    const stored = storedByKey.get(`${job.trip_date}:${job.job_id}`);
    if (stored?.distance_km != null) job.distance_km = Number(stored.distance_km);
  }
  await attachPayDistances(expectedJobs.filter((job) => job.distance_km == null));

  const source_exceptions = sources.flatMap((day) => day.source_exceptions.map((message) => `${day.date}: ${message}`));
  const tracking = new Map<string, Array<{ job_id: number; driver_name: string | null }>>();
  for (const day of sources) for (const [number, matches] of Object.entries(day.tracking)) {
    tracking.set(number, [...(tracking.get(number) ?? []), ...matches]);
  }
  const expectedById = new Map(expectedJobs.map((job) => [job.job_id, job]));
  const regression = args.get("regression") ? JSON.parse(readFileSync(resolve(args.get("regression")!), "utf8")) as {
    driver_id: string; driver_name: string; tracking_numbers: string[]; distance_per_job: number;
    pickup_customer_id: string; dropoff_customer_id: string;
  } : null;
  if (month === "2026-09" && !regression) source_exceptions.push("September acceptance requires --regression=<restricted case file>");
  const tuanRows: PayJob[] = [];
  for (const number of regression?.tracking_numbers ?? []) {
    const matches = tracking.get(number) ?? [];
    const unique = [...new Map(matches.map((match) => [`${match.job_id}:${match.driver_name}`, match])).values()];
    const match = unique.length === 1 ? unique[0] : undefined;
    const job = match ? expectedById.get(match.job_id) : undefined;
    if (!match || !job || job.driver_id !== regression!.driver_id || !match.driver_name?.includes(regression!.driver_name) ||
        job.distance_km !== regression!.distance_per_job || job.pickup_customer_id !== regression!.pickup_customer_id ||
        job.dropoff_customer_id !== regression!.dropoff_customer_id) {
      source_exceptions.push(`Regression: ${number} did not resolve uniquely to the verified account and route distance`);
    } else tuanRows.push(job);
  }
  const tuanKm = Math.round(tuanRows.reduce((sum, job) => sum + (job.distance_km ?? 0), 0) * 100) / 100;
  const regressionKm = regression ? Math.round(regression.tracking_numbers.length * regression.distance_per_job * 100) / 100 : 0;
  if (regression && (tuanRows.length !== regression.tracking_numbers.length || tuanKm !== regressionKm)) {
    source_exceptions.push(`Regression: expected ${regression.tracking_numbers.length} jobs / ${regressionKm} km, got ${tuanRows.length} jobs / ${tuanKm} km`);
  }

  const jobDiff = diffPayRows(expectedJobs, relevantRows(baseline.jobs, expectedJobs));
  const punchDiff = diffPayRows(expectedPunches, relevantRows(baseline.punches, expectedPunches));
  source_exceptions.push(...jobDiff.duplicates.map((key) => `duplicate payroll job ${key}`),
    ...punchDiff.duplicates.map((key) => `duplicate payroll punch ${key}`));
  const driverExpected = summarizeDrivers(expectedJobs, expectedPunches);
  const driverBaseline = summarizeDrivers(onlyPartTime(baseline.jobs), onlyPartTime(baseline.punches));
  const attendance_exceptions = driverExpected.reduce((sum, row) => sum + row.open_in + row.stray_out, 0);
  const report_id = basename(runDir);
  const proposal: Proposal = {
    version: 1, mode: "dry-run", report_id, month, from, to, created_at: new Date().toISOString(),
    failed_days, source_exceptions, attendance_exceptions,
    jobs: expectedJobs, punches: expectedPunches,
    deletions: { jobs: jobDiff.stale.map(({ trip_date, job_id }) => ({ trip_date, job_id })), punches: punchDiff.stale.map(({ trip_date, job_id }) => ({ trip_date, job_id })) },
  };
  const report = {
    report_id, mode: "dry-run", month, from, to,
    source: {
      days_expected: payrollDays(from, to).length, days_read: sources.length, failed_days,
      empty_days: sources.filter((day) => day.jobs.length === 0 && day.punches.length === 0).map((day) => day.date),
      days: sources.map((day) => ({ date: day.date, timeline_jobs: day.jobs.length, rest_jobs: day.rest_job_ids.length, punches: day.punches.length, rest_punches: day.rest_punch_ids.length, exceptions: day.source_exceptions.length })),
      timeline_jobs: expectedJobs.length, rest_jobs: sources.reduce((sum, day) => sum + day.rest_job_ids.length, 0),
      punches: expectedPunches.length, source_exceptions,
    },
    baseline: { jobs: onlyPartTime(baseline.jobs).length, punches: onlyPartTime(baseline.punches).length, drivers: driverBaseline },
    proposed: {
      jobs: expectedJobs.length, punches: expectedPunches.length,
      missing_jobs: jobDiff.missing.map((row) => ({ date: row.trip_date, job_id: row.job_id, driver: row.driver_name })),
      stale_jobs: proposal.deletions.jobs, changed_jobs: jobDiff.changed, wrong_driver_jobs: jobDiff.wrong_driver, wrong_date_jobs: jobDiff.wrong_date, duplicate_jobs: jobDiff.duplicates,
      missing_punches: punchDiff.missing.map((row) => ({ date: row.trip_date, job_id: row.job_id, driver: row.driver_name, kind: row.kind })),
      stale_punches: proposal.deletions.punches, changed_punches: punchDiff.changed, wrong_driver_punches: punchDiff.wrong_driver, wrong_date_punches: punchDiff.wrong_date, duplicate_punches: punchDiff.duplicates,
      unpriced_jobs: expectedJobs.filter((row) => row.distance_km == null).map((row) => ({ date: row.trip_date, job_id: row.job_id, driver: row.driver_name })),
      attendance_exceptions, drivers: driverExpected,
      days: sources.map((day) => ({ date: day.date, drivers: summarizeDrivers(day.jobs, day.punches),
        attendance_review: [...new Set(day.punches.map((row) => row.driver_id))].map((driver_id) => {
          const worked = workedMinutes(day.punches.filter((row) => row.driver_id === driver_id));
          return { driver_id, open_in: worked.open_in, stray_out: worked.stray_out };
        }).filter((row) => row.open_in.length || row.stray_out.length),
      })),
    },
    regression: regression ? { driver: regression.driver_name, tracking_numbers: regression.tracking_numbers.length, matched_jobs: tuanRows.length, km: tuanKm, km_pay: Math.round(tuanKm * 2000) } : null,
  };
  writePrivateJson(resolve(runDir, "proposal.json"), proposal);
  writePrivateJson(resolve(runDir, "audit.json"), report);
  process.stdout.write(`\nDry run complete. Review ${resolve(runDir, "audit.json")}\nProposal: ${resolve(runDir, "proposal.json")}\n`);
}

async function applyProposal(path: string) {
  const proposal = JSON.parse(readFileSync(resolve(path), "utf8")) as Proposal;
  validateProposal(proposal);
  if (confirm !== `APPLY-${proposal.month}`) throw new Error(`Apply requires --confirm=APPLY-${proposal.month}`);
  if (proposal.failed_days.length) throw new Error("Cannot apply a proposal with failed source days");
  if (proposal.source_exceptions.length) throw new Error("Resolve source disagreements and duplicate rows before applying this proposal");
  const runDir = dirname(resolve(path));
  const approved: Proposal["deletions"] = deleteListPath
    ? JSON.parse(readFileSync(resolve(deleteListPath), "utf8")) : { jobs: [], punches: [] };
  const proposedJobs = new Set(proposal.deletions.jobs.map((row) => `${row.trip_date}:${row.job_id}`));
  const proposedPunches = new Set(proposal.deletions.punches.map((row) => `${row.trip_date}:${row.job_id}`));
  if ((approved.jobs ?? []).some((row) => !proposedJobs.has(`${row.trip_date}:${row.job_id}`)) ||
      (approved.punches ?? []).some((row) => !proposedPunches.has(`${row.trip_date}:${row.job_id}`))) {
    throw new Error("Delete list contains rows that were not in the reviewed proposal");
  }
  const current = await selectStored(proposal.from, proposal.to);
  const statePath = resolve(runDir, "apply-state.json");
  let state: { started?: boolean; completed_days: string[] } = { completed_days: [] };
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* first run */ }
  if (!state.started) {
    const baseline = JSON.parse(readFileSync(resolve(runDir, "baseline.json"), "utf8")) as { jobs: StoredPayJob[]; punches: StoredPayPunch[] };
    const baselineJobs = diffPayRows(baseline.jobs, current.jobs);
    const baselinePunches = diffPayRows(baseline.punches, current.punches);
    if ([baselineJobs, baselinePunches].some((diff) => diff.missing.length || diff.stale.length || diff.changed.length)) {
      throw new Error("Payroll changed after the dry run; generate and review a fresh proposal before applying");
    }
    writePrivateJson(resolve(runDir, "pre-apply-backup.json"), { month: proposal.month, from: proposal.from, to: proposal.to, captured_at: new Date().toISOString(), ...current });
    writePrivateJson(resolve(runDir, "rollback-keys.json"), {
      jobs: diffPayRows(proposal.jobs, current.jobs).missing.map(({ trip_date, job_id }) => ({ trip_date, job_id })),
      punches: diffPayRows(proposal.punches, current.punches).missing.map(({ trip_date, job_id }) => ({ trip_date, job_id })),
    });
    state.started = true;
    writePrivateJson(statePath, state);
  }
  const approvedPath = resolve(runDir, "approved-deletions.json");
  let previousApproved: Proposal["deletions"] = { jobs: [], punches: [] };
  try { previousApproved = JSON.parse(readFileSync(approvedPath, "utf8")); } catch { /* first deletion list */ }
  const unionKeys = (old: Proposal["deletions"]["jobs"], added: Proposal["deletions"]["jobs"]) =>
    [...new Map([...old, ...added].map((row) => [`${row.trip_date}:${row.job_id}`, row])).values()];
  writePrivateJson(approvedPath, { jobs: unionKeys(previousApproved.jobs, approved.jobs), punches: unionKeys(previousApproved.punches, approved.punches) });
  await setPayrollCoverage({
    month: proposal.month, from: proposal.from, to: proposal.to,
    days_expected: payrollDays(proposal.from, proposal.to).length, days_reconciled: state.completed_days.length,
    failed_days: [], source_exceptions: 0, unpriced_jobs: 0, attendance_exceptions: proposal.attendance_exceptions,
    complete: false, ready_for_approval: false, reconciled_at: new Date().toISOString(), report_id: proposal.report_id,
  });

  for (const date of payrollDays(proposal.from, proposal.to)) {
    if (state.completed_days.includes(date)) continue;
    const stamp = new Date().toISOString();
    const jobs = proposal.jobs.filter((row) => row.trip_date === date).map((row) => ({ ...row, archived_at: stamp }));
    const punches = proposal.punches.filter((row) => row.trip_date === date).map((row) => ({ ...row, archived_at: stamp }));
    await sbUpsert("pay_jobs", jobs as unknown as Record<string, unknown>[], "trip_date,job_id");
    await sbUpsert("pay_punches", punches as unknown as Record<string, unknown>[], "trip_date,job_id");
    const written = await selectStored(date, date);
    const writtenJobs = diffPayRows(proposal.jobs.filter((row) => row.trip_date === date), written.jobs);
    const writtenPunches = diffPayRows(proposal.punches.filter((row) => row.trip_date === date), written.punches);
    if ([writtenJobs, writtenPunches].some((diff) => diff.missing.length || diff.changed.length || diff.duplicates.length)) {
      throw new Error(`Payroll write verification failed for ${date}; this day remains retryable`);
    }
    state.completed_days.push(date);
    writePrivateJson(statePath, state);
    process.stdout.write(`applied ${date}: ${jobs.length} jobs, ${punches.length} punches\n`);
  }

  if (deleteListPath) {
    const beforeApply = JSON.parse(readFileSync(resolve(runDir, "pre-apply-backup.json"), "utf8")) as { jobs: StoredPayJob[]; punches: StoredPayPunch[] };
    for (const [keys, original, stored] of [[approved.jobs, beforeApply.jobs, current.jobs], [approved.punches, beforeApply.punches, current.punches]] as const) {
      for (const key of keys) {
        const now = stored.find((row) => row.trip_date === key.trip_date && row.job_id === key.job_id);
        const old = original.find((row) => row.trip_date === key.trip_date && row.job_id === key.job_id);
        if (now && (!old || diffPayRows([old], [now]).changed.length)) throw new Error(`Reviewed deletion ${key.trip_date}:${key.job_id} changed after baseline`);
      }
    }
    for (const row of approved.jobs ?? []) {
      const before = current.jobs.find((old) => old.trip_date === row.trip_date && old.job_id === row.job_id);
      if (before?.archived_at) await sbDelete("pay_jobs", `trip_date=eq.${row.trip_date}&job_id=eq.${row.job_id}&archived_at=eq.${encodeURIComponent(before.archived_at)}`);
    }
    for (const row of approved.punches ?? []) {
      const before = current.punches.find((old) => old.trip_date === row.trip_date && old.job_id === row.job_id);
      if (before?.archived_at) await sbDelete("pay_punches", `trip_date=eq.${row.trip_date}&job_id=eq.${row.job_id}&archived_at=eq.${encodeURIComponent(before.archived_at)}`);
    }
  }

  const after = await selectStored(proposal.from, proposal.to);
  const jobDiff = diffPayRows(proposal.jobs, relevantRows(after.jobs, proposal.jobs));
  const punchDiff = diffPayRows(proposal.punches, relevantRows(after.punches, proposal.punches));
  const unpriced = proposal.jobs.filter((row) => row.distance_km == null).length;
  const sourceExceptions = proposal.source_exceptions.length + jobDiff.missing.length + punchDiff.missing.length + jobDiff.stale.length + punchDiff.stale.length + jobDiff.changed.length + punchDiff.changed.length + jobDiff.duplicates.length + punchDiff.duplicates.length;
  const complete = state.completed_days.length === payrollDays(proposal.from, proposal.to).length && sourceExceptions === 0 && unpriced === 0;
  const coverage: PayrollCoverage = {
    month: proposal.month, from: proposal.from, to: proposal.to,
    days_expected: payrollDays(proposal.from, proposal.to).length,
    days_reconciled: state.completed_days.length,
    failed_days: proposal.failed_days.map((day) => day.date),
    source_exceptions: sourceExceptions, unpriced_jobs: unpriced,
    attendance_exceptions: proposal.attendance_exceptions,
    complete,
    ready_for_approval: complete && proposal.attendance_exceptions === 0,
    reconciled_at: new Date().toISOString(), report_id: proposal.report_id,
  };
  await setPayrollCoverage(coverage);
  const result = {
    report_id: proposal.report_id, mode: "apply", applied_at: coverage.reconciled_at,
    coverage, after: { jobs: onlyPartTime(after.jobs).length, punches: onlyPartTime(after.punches).length, drivers: summarizeDrivers(onlyPartTime(after.jobs), onlyPartTime(after.punches)) },
    remaining: { missing_jobs: jobDiff.missing.length, stale_jobs: jobDiff.stale.length, missing_punches: punchDiff.missing.length, stale_punches: punchDiff.stale.length },
  };
  writePrivateJson(resolve(runDir, "apply-audit.json"), result);
  process.stdout.write(`\n${complete ? "Reconciliation verified" : "Reconciliation remains incomplete"}. ${coverage.ready_for_approval ? "Ready for payroll review." : "Not ready for approval."} Audit: ${resolve(runDir, "apply-audit.json")}\n`);
  if (!complete) process.exitCode = 2;
}

async function rollbackRun(directory: string) {
  const runDir = resolve(directory);
  const proposal = JSON.parse(readFileSync(resolve(runDir, "proposal.json"), "utf8")) as Proposal;
  validateProposal(proposal);
  if (confirm !== `ROLLBACK-${proposal.month}`) throw new Error(`Rollback requires --confirm=ROLLBACK-${proposal.month}`);
  const backup = JSON.parse(readFileSync(resolve(runDir, "pre-apply-backup.json"), "utf8")) as { jobs: StoredPayJob[]; punches: StoredPayPunch[] };
  const inserted = JSON.parse(readFileSync(resolve(runDir, "rollback-keys.json"), "utf8")) as Proposal["deletions"];
  const deleted = JSON.parse(readFileSync(resolve(runDir, "approved-deletions.json"), "utf8")) as Proposal["deletions"];
  const keyOf = (row: { trip_date: string; job_id: number }) => `${row.trip_date}:${row.job_id}`;
  const touchedJobs = new Set([...proposal.jobs, ...deleted.jobs].map(keyOf));
  const touchedPunches = new Set([...proposal.punches, ...deleted.punches].map(keyOf));
  const restoreJobs = backup.jobs.filter((row) => touchedJobs.has(keyOf(row)));
  const restorePunches = backup.punches.filter((row) => touchedPunches.has(keyOf(row)));
  const current = await selectStored(proposal.from, proposal.to);
  const assertUnchanged = <T extends PayJob | PayPunch>(before: T[], applied: T[], stored: T[], touched: Set<string>) => {
    for (const row of stored.filter((item) => touched.has(keyOf(item)))) {
      const original = before.find((item) => keyOf(item) === keyOf(row));
      const expected = applied.find((item) => keyOf(item) === keyOf(row));
      if ((!original || diffPayRows([original], [row]).changed.length) &&
          (!expected || diffPayRows([expected], [row]).changed.length)) {
        throw new Error(`Row ${keyOf(row)} changed after this run; review before rollback`);
      }
    }
  };
  assertUnchanged(restoreJobs, proposal.jobs, current.jobs, touchedJobs);
  assertUnchanged(restorePunches, proposal.punches, current.punches, touchedPunches);
  writePrivateJson(resolve(runDir, `pre-rollback-backup-${Date.now()}.json`), current);
  await setPayrollCoverage({
    month: proposal.month, from: proposal.from, to: proposal.to, days_expected: payrollDays(proposal.from, proposal.to).length,
    days_reconciled: 0, failed_days: [], source_exceptions: 0, unpriced_jobs: 0, attendance_exceptions: 0,
    complete: false, ready_for_approval: false, reconciled_at: new Date().toISOString(), report_id: `${proposal.report_id}-rollback`,
  });
  const withoutIdentity = (row: StoredPayJob | StoredPayPunch) => {
    const copy = { ...row } as Record<string, unknown>;
    delete copy.id;
    return copy;
  };
  await sbUpsert("pay_jobs", restoreJobs.map(withoutIdentity), "trip_date,job_id");
  await sbUpsert("pay_punches", restorePunches.map(withoutIdentity), "trip_date,job_id");
  for (const [table, keys, rows] of [
    ["pay_jobs", inserted.jobs, current.jobs], ["pay_punches", inserted.punches, current.punches],
  ] as const) for (const key of keys) {
    const row = rows.find((item) => keyOf(item) === keyOf(key));
    if (row?.archived_at) await sbDelete(table, `trip_date=eq.${key.trip_date}&job_id=eq.${key.job_id}&archived_at=eq.${encodeURIComponent(row.archived_at)}`);
  }
  const after = await selectStored(proposal.from, proposal.to);
  const jobs = diffPayRows(restoreJobs, after.jobs.filter((row) => touchedJobs.has(keyOf(row))));
  const punches = diffPayRows(restorePunches, after.punches.filter((row) => touchedPunches.has(keyOf(row))));
  const ok = [jobs, punches].every((diff) => !diff.missing.length && !diff.stale.length && !diff.changed.length);
  writePrivateJson(resolve(runDir, "rollback-audit.json"), { ok, rolled_back_at: new Date().toISOString(), jobs, punches });
  if (!ok) throw new Error("Rollback verification has remaining differences; review rollback-audit.json");
  writePrivateJson(resolve(runDir, "apply-state.json"), { completed_days: [] });
  process.stdout.write(`Rollback verified. Audit: ${resolve(runDir, "rollback-audit.json")}\n`);
}

if (args.has("apply") && !applyPath) throw new Error("Use --apply=<reviewed proposal.json path>");
if (args.has("rollback") && !rollbackDir) throw new Error("Use --rollback=<audit run directory>");
if (applyPath && rollbackDir) throw new Error("Apply and rollback cannot run together");
if (capturePath) {
  if (applyPath || rollbackDir || baselinePath || !recipientPath || capturePath === "true") throw new Error("Capture requires --capture-baseline=<encrypted file> --recipient=<public key file>");
  const { from, to } = payrollPeriod(month);
  const stored = await selectStored(from, to);
  const snapshot = { month, from, to, captured_at: new Date().toISOString(), ...stored,
    drivers: summarizeDrivers(onlyPartTime(stored.jobs), onlyPartTime(stored.punches)) };
  writePrivateJson(resolve(capturePath), encryptAudit(JSON.stringify(snapshot), readFileSync(resolve(recipientPath), "utf8")));
  process.stdout.write(`Encrypted baseline captured for ${month}; ${stored.jobs.length} jobs and ${stored.punches.length} punches.\n`);
} else if (rollbackDir) await rollbackRun(rollbackDir); else if (applyPath) await applyProposal(applyPath); else await dryRun();
