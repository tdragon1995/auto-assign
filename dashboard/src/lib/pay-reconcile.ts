/**
 * Payroll-only reconciliation of one day: what Cartrack says was worked, against
 * what pay_jobs / pay_punches hold, and — only when asked — the write that makes
 * them agree.
 *
 * WHY THIS EXISTS. The pay archive shipped on 2026-08-30 and rides the morning
 * seal, which reaches back three days. Nothing backfilled the days before it, so
 * the September period (15/08–14/09) was two thirds absent while Tính lương read
 * it as complete. The only backfill that existed was /api/tat/archive, which also
 * rewrites tat_legs and deletes stale rows — not something to run to fix pay.
 *
 * WHAT IT NEVER DOES
 *   - touch tat_legs;
 *   - delete a row nobody reviewed: extras are REPORTED, and removed only when
 *     the caller names them in `delete_job_ids` / `delete_punch_ids` AND they are
 *     still extras when the write runs;
 *   - replace a stored distance with a failed lookup (`keepStoredDistances`);
 *   - invent a clock-out: punches are Cartrack's raw stamps, unpaired taps are
 *     listed as exceptions;
 *   - apply a diff that differs from the one reviewed: apply requires the
 *     dry-run's `digest`, and refuses if the day recomputes differently.
 */
import { createHash } from "node:crypto";
import { getTimelineRoutes, getJobsByStatusAndDate, type Env } from "./cartrack";
import { payRowsForRoute, attachPayDistances, workedMinutes, hourPayFor, kmPayFor, type PayJob, type PayPunch } from "./pay";
import { isChamCong } from "./job-filters";
import { employmentOf } from "./driver-label";
import { sbSelectAll, sbUpsert, sbDelete } from "./supabase-rest";
import type { DistanceStats } from "./tat";
import type { Job, TimelineRoute } from "./types";

type StoredJob = PayJob & { id?: number; archived_at?: string };
type StoredPunch = PayPunch & { id?: number; archived_at?: string };

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** 5 dp, truncated — the distance cache's own key precision. */
const coordKey = (lat: unknown, lng: unknown) =>
  `${Math.trunc(Number(lat) * 1e5)},${Math.trunc(Number(lng) * 1e5)}`;
const pairKey = (j: Pick<PayJob, "pickup_lat" | "pickup_lng" | "dropoff_lat" | "dropoff_lng">) =>
  `${coordKey(j.pickup_lat, j.pickup_lng)}>${coordKey(j.dropoff_lat, j.dropoff_lng)}`;

async function retry<T>(what: string, fn: () => Promise<T | null>, tries = 3): Promise<T> {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fn();
      if (r !== null) return r;
      last = "no data";
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
  }
  throw new Error(`${what} failed after ${tries} tries: ${last}`);
}

/**
 * A job whose fresh lookup failed keeps the distance already stored for the SAME
 * pickup→dropoff coordinates. Different coordinates mean a different trip, and an
 * old figure for it would be a guess. Mutates `jobs`; returns how many it kept.
 */
export function keepStoredDistances(jobs: PayJob[], stored: StoredJob[]): number {
  const byId = new Map(stored.map((s) => [Number(s.job_id), s]));
  let kept = 0;
  for (const j of jobs) {
    if (j.distance_km != null) continue;
    const s = byId.get(j.job_id);
    const km = num(s?.distance_km);
    if (s && km != null && pairKey(s) === pairKey(j)) { j.distance_km = km; kept++; }
  }
  return kept;
}

export interface Exception { kind: string; driver_id?: string; driver_name?: string | null; job_id?: number; detail: string }

/** The rows that carry through to totals, per driver. */
function totalsByDriver(jobs: PayJob[], punches: PayPunch[]) {
  const m = new Map<string, { driver_name: string | null; jobs: number; km: number; worked_mins: number; pay: number; open_in: number; stray_out: number }>();
  const get = (id: string, name: string | null) => {
    const e = m.get(id) ?? { driver_name: name, jobs: 0, km: 0, worked_mins: 0, pay: 0, open_in: 0, stray_out: 0 };
    if (!e.driver_name && name) e.driver_name = name;
    m.set(id, e);
    return e;
  };
  for (const j of jobs) { const e = get(j.driver_id, j.driver_name); e.jobs++; e.km += num(j.distance_km) ?? 0; }
  const punchesBy = new Map<string, PayPunch[]>();
  for (const p of punches) {
    get(p.driver_id, p.driver_name);
    const l = punchesBy.get(p.driver_id); if (l) l.push(p); else punchesBy.set(p.driver_id, [p]);
  }
  for (const [id, e] of m) {
    const w = workedMinutes(punchesBy.get(id) ?? []);
    e.worked_mins = w.minutes; e.open_in = w.open_in.length; e.stray_out = w.stray_out.length;
    e.km = round2(e.km);
    e.pay = hourPayFor(e.worked_mins) + kmPayFor(e.km);
  }
  return Object.fromEntries(m);
}

const jobFacts = (j: PayJob) => JSON.stringify([
  j.driver_id, j.reference_number, j.pickup_customer_id, j.dropoff_customer_id,
  num(j.distance_km), j.pickup_completed_ts && Date.parse(j.pickup_completed_ts), j.dropoff_completed_ts && Date.parse(j.dropoff_completed_ts),
]);
const punchFacts = (p: PayPunch) => JSON.stringify([
  p.driver_id, p.kind, ...[p.started_ts, p.arrived_ts, p.completed_ts].map((t) => (t ? Date.parse(t) : null)),
]);

export interface DayInput {
  date: string;
  routes: TimelineRoute[];
  /** REST completed jobs scheduled that day — the cross-check source. */
  restCompleted: Job[];
  stored: { jobs: StoredJob[]; punches: StoredPunch[] };
  /** The same job ids stored under ANOTHER trip_date. */
  otherDates: { job_id: number; trip_date: string; driver_id: string }[];
}

/**
 * The pure half: sources + stored in, proposed write + diff + exceptions out.
 * Distances must already be attached to `proposed` jobs by the caller.
 */
export function diffPayDay(input: DayInput, proposedJobsIn: PayJob[], proposedPunchesIn: PayPunch[], tracking: Map<number, string[]>) {
  const { date, restCompleted, stored } = input;
  const exceptions: Exception[] = [];

  // A job on two drivers' routes cannot be paid twice, and the timeline alone
  // cannot say whose it is. REST's delivery_driver_id decides; without it the job
  // is held out of the write and listed.
  const restDriver = new Map<number, string | null>();
  for (const j of restCompleted) {
    if (isChamCong(j)) continue;
    const types = new Set((j.stops ?? []).map((s) => Number(s.stop_type_id)));
    if (!types.has(1) || !types.has(2)) continue;
    restDriver.set(Number(j.job_id), j.delivery_driver_id ?? null);
  }
  const dedupe = <T extends { job_id: number; driver_id: string; driver_name: string | null }>(rows: T[], label: string): T[] => {
    const by = new Map<number, T[]>();
    for (const r of rows) { const l = by.get(r.job_id); if (l) l.push(r); else by.set(r.job_id, [r]); }
    const out: T[] = [];
    for (const [id, list] of by) {
      const drivers = new Set(list.map((r) => r.driver_id));
      if (drivers.size === 1) { out.push(list[0]); if (list.length > 1) exceptions.push({ kind: `${label}_repeated_in_source`, job_id: id, detail: `${list.length} copies on one route, kept one` }); continue; }
      const owner = restDriver.get(id);
      const pick = owner ? list.find((r) => r.driver_id === owner) : undefined;
      if (pick) { out.push(pick); exceptions.push({ kind: `${label}_duplicate_resolved`, job_id: id, driver_id: pick.driver_id, driver_name: pick.driver_name, detail: `on ${drivers.size} routes; kept REST driver` }); }
      else exceptions.push({ kind: `${label}_duplicate_unresolved`, job_id: id, detail: `on routes of ${[...list.map((r) => r.driver_name ?? r.driver_id)].join(", ")}; NOT written` });
    }
    return out;
  };
  const jobs = dedupe(proposedJobsIn, "job");
  const punches = dedupe(proposedPunchesIn, "punch");

  const storedJobs = new Map(stored.jobs.map((j) => [Number(j.job_id), j]));
  const storedPunches = new Map(stored.punches.map((p) => [Number(p.job_id), p]));
  const srcJobIds = new Set(proposedJobsIn.map((j) => j.job_id));
  const srcPunchIds = new Set(proposedPunchesIn.map((p) => p.job_id));

  const line = (j: PayJob) => ({
    job_id: j.job_id, driver_id: j.driver_id, driver_name: j.driver_name, reference_number: j.reference_number,
    tracking: tracking.get(j.job_id) ?? [], pickup: j.pickup_name, dropoff: j.dropoff_name, km: num(j.distance_km),
  });

  const missingJobs = jobs.filter((j) => !storedJobs.has(j.job_id)).map(line);
  const changedJobs = jobs.filter((j) => storedJobs.has(j.job_id) && jobFacts(j) !== jobFacts(storedJobs.get(j.job_id)!))
    .map((j) => { const s = storedJobs.get(j.job_id)!; return { ...line(j), stored_driver_id: s.driver_id, stored_km: num(s.distance_km) }; });
  const extraJobs = stored.jobs.filter((s) => !srcJobIds.has(Number(s.job_id))).map((s) => line({ ...s, job_id: Number(s.job_id) }));
  const missingPunches = punches.filter((p) => !storedPunches.has(p.job_id));
  const changedPunches = punches.filter((p) => storedPunches.has(p.job_id) && punchFacts(p) !== punchFacts(storedPunches.get(p.job_id)!));
  const extraPunches = stored.punches.filter((s) => !srcPunchIds.has(Number(s.job_id)));

  for (const j of jobs) {
    if (j.distance_km != null) continue;
    const noCoords = j.pickup_lat == null || j.pickup_lng == null || j.dropoff_lat == null || j.dropoff_lng == null;
    exceptions.push({ kind: noCoords ? "job_missing_coordinates" : "job_unpriced", job_id: j.job_id, driver_id: j.driver_id, driver_name: j.driver_name, detail: `${j.pickup_name} → ${j.dropoff_name}` });
  }
  for (const o of input.otherDates) {
    exceptions.push({ kind: "job_on_other_date", job_id: o.job_id, driver_id: o.driver_id, detail: `also stored under ${o.trip_date}; kept the scheduled-day rule, review` });
  }

  // Cross-check: REST completed pickup→dropoff jobs against the timeline's.
  const timelineDriver = new Map(proposedJobsIn.map((j) => [j.job_id, j.driver_id]));
  for (const [id, drv] of restDriver) {
    if (!timelineDriver.has(id)) exceptions.push({ kind: "rest_only_job", job_id: id, driver_id: drv ?? undefined, detail: "completed in REST, absent from the timeline — not paid, review" });
    else if (drv && timelineDriver.get(id) !== drv) exceptions.push({ kind: "driver_disagreement", job_id: id, driver_id: timelineDriver.get(id), detail: `timeline driver ≠ REST driver ${drv}` });
  }
  for (const id of timelineDriver.keys()) {
    if (!restDriver.has(id)) exceptions.push({ kind: "timeline_only_job", job_id: id, driver_id: timelineDriver.get(id), detail: "paid from timeline, not in REST completed list for this scheduled day" });
  }

  const after = totalsByDriver(jobs, punches);
  for (const [driver_id, t] of Object.entries(after)) {
    if (t.open_in > 0) exceptions.push({ kind: "attendance_open_in", driver_id, driver_name: t.driver_name, detail: `${t.open_in} check-in without check-out (pays 0)` });
    if (t.stray_out > 0) exceptions.push({ kind: "attendance_stray_out", driver_id, driver_name: t.driver_name, detail: `${t.stray_out} check-out without check-in (pays 0)` });
  }

  const digest = createHash("sha256")
    .update(JSON.stringify([jobs.map(jobFacts).sort(), punches.map(punchFacts).sort(), extraJobs.map((e) => e.job_id).sort(), extraPunches.map((p) => Number(p.job_id)).sort()]))
    .digest("hex").slice(0, 16);

  const partTime = (t: Record<string, { driver_name: string | null; jobs: number; km: number; worked_mins: number; pay: number }>) =>
    Object.values(t).filter((d) => employmentOf(d.driver_name) === "part-time")
      .reduce((s, d) => ({ drivers: s.drivers + 1, jobs: s.jobs + d.jobs, km: round2(s.km + d.km), worked_mins: s.worked_mins + d.worked_mins, pay: s.pay + d.pay }), { drivers: 0, jobs: 0, km: 0, worked_mins: 0, pay: 0 });
  const before = totalsByDriver(stored.jobs, stored.punches);

  return {
    date, digest,
    write: { jobs, punches },
    source_counts: {
      timeline_routes: input.routes.length, timeline_paid_jobs: srcJobIds.size, timeline_punches: srcPunchIds.size,
      rest_completed_pairs: restDriver.size, stored_jobs: stored.jobs.length, stored_punches: stored.punches.length,
    },
    diff: {
      missing_jobs: missingJobs, changed_jobs: changedJobs, extra_jobs: extraJobs,
      missing_punches: missingPunches.length, changed_punches: changedPunches.length,
      extra_punches: extraPunches.map((p) => ({ job_id: Number(p.job_id), driver_id: p.driver_id, driver_name: p.driver_name, kind: p.kind })),
    },
    exceptions,
    totals: { before: partTime(before), after: partTime(after), by_driver_before: before, by_driver_after: after },
  };
}

export interface ReconcileOptions {
  apply?: boolean;
  /** Required with apply: the dry-run digest that was reviewed. */
  digest?: string;
  delete_job_ids?: number[];
  delete_punch_ids?: number[];
}

export async function reconcilePayDay(date: string, opts: ReconcileOptions = {}, env: Env = "prod") {
  const routes = await retry("timeline fetch", () => getTimelineRoutes(date, env));
  const restCompleted = await retry("REST completed fetch", () => getJobsByStatusAndDate(5, date, env));

  const [storedJobs, storedPunches] = await Promise.all([
    sbSelectAll<StoredJob>("pay_jobs", `select=*&trip_date=eq.${date}`, "job_id.asc"),
    sbSelectAll<StoredPunch>("pay_punches", `select=*&trip_date=eq.${date}`, "job_id.asc"),
  ]);

  const jobs: PayJob[] = [];
  const punches: PayPunch[] = [];
  const tracking = new Map<number, string[]>();
  for (const r of routes) {
    const rows = payRowsForRoute(r, date);
    jobs.push(...rows.jobs); punches.push(...rows.punches);
    for (const s of r.orderedStops ?? []) {
      if (s.itemTrackingNumbers?.length) tracking.set(Number(s.jobId), s.itemTrackingNumbers);
    }
  }

  // Cached distances first: a stored figure for the identical pair is reused
  // without asking anyone; only the rest go to the provider chain.
  const reused = keepStoredDistances(jobs, storedJobs);
  const toPrice = jobs.filter((j) => j.distance_km == null);
  const stats: DistanceStats = await attachPayDistances(toPrice);

  const ids = [...new Set(jobs.map((j) => j.job_id))];
  const otherDates: DayInput["otherDates"] = [];
  for (let i = 0; i < ids.length; i += 150) {
    otherDates.push(...await sbSelectAll<DayInput["otherDates"][number]>(
      "pay_jobs", `select=job_id,trip_date,driver_id&trip_date=neq.${date}&job_id=in.(${ids.slice(i, i + 150).join(",")})`, "id.asc"));
  }

  const report = diffPayDay({ date, routes, restCompleted, stored: { jobs: storedJobs, punches: storedPunches }, otherDates }, jobs, punches, tracking);
  const { write, ...rest } = report;
  const base = { ok: true, mode: opts.apply ? "apply" : "dry-run", distances: { ...stats, reused_stored: reused }, ...rest, backup: { jobs: storedJobs, punches: storedPunches } };

  if (!opts.apply) return base;
  if (!opts.digest || opts.digest !== report.digest) {
    return { ...base, ok: false, error: `digest mismatch: reviewed ${opts.digest ?? "(none)"}, now ${report.digest} — re-run the dry-run and review again` };
  }

  const stamp = new Date().toISOString();
  await sbUpsert("pay_jobs", write.jobs.map((j) => ({ ...j, archived_at: stamp })) as unknown as Record<string, unknown>[], "trip_date,job_id");
  await sbUpsert("pay_punches", write.punches.map((p) => ({ ...p, archived_at: stamp })) as unknown as Record<string, unknown>[], "trip_date,job_id");

  const extraJobIds = new Set(report.diff.extra_jobs.map((e) => e.job_id));
  const extraPunchIds = new Set(report.diff.extra_punches.map((e) => e.job_id));
  const delJobs = (opts.delete_job_ids ?? []).filter((id) => extraJobIds.has(id));
  const delPunches = (opts.delete_punch_ids ?? []).filter((id) => extraPunchIds.has(id));
  if (delJobs.length) await sbDelete("pay_jobs", `trip_date=eq.${date}&job_id=in.(${delJobs.join(",")})`);
  if (delPunches.length) await sbDelete("pay_punches", `trip_date=eq.${date}&job_id=in.(${delPunches.join(",")})`);

  await markPayDay(date, write.jobs.length, write.punches.length, write.jobs.filter((j) => j.distance_km == null).length, "reconcile");

  return {
    ...base,
    applied: {
      upserted_jobs: write.jobs.length, upserted_punches: write.punches.length,
      deleted_job_ids: delJobs, deleted_punch_ids: delPunches,
      refused_deletes: [
        ...(opts.delete_job_ids ?? []).filter((id) => !extraJobIds.has(id)).map((id) => `job ${id}`),
        ...(opts.delete_punch_ids ?? []).filter((id) => !extraPunchIds.has(id)).map((id) => `punch ${id}`),
      ],
    },
  };
}

/**
 * Put a day back exactly as a backup holds it: upsert the backup rows, then delete
 * rows for the day the backup did not have (what an apply added).
 */
export async function restorePayDay(date: string, backup: { jobs: StoredJob[]; punches: StoredPunch[] }) {
  const strip = <T extends { id?: number }>(r: T) => { const { id: _id, ...rest } = r; return rest; };
  const jobs = backup.jobs.filter((j) => j.trip_date === date).map(strip);
  const punches = backup.punches.filter((p) => p.trip_date === date).map(strip);
  await sbUpsert("pay_jobs", jobs as unknown as Record<string, unknown>[], "trip_date,job_id");
  await sbUpsert("pay_punches", punches as unknown as Record<string, unknown>[], "trip_date,job_id");
  const notIn = (ids: number[]) => (ids.length ? `&job_id=not.in.(${ids.join(",")})` : "");
  await sbDelete("pay_jobs", `trip_date=eq.${date}${notIn(jobs.map((j) => Number(j.job_id)))}`);
  await sbDelete("pay_punches", `trip_date=eq.${date}${notIn(punches.map((p) => Number(p.job_id)))}`);
  await sbDelete("pay_days", `trip_date=eq.${date}&source=eq.reconcile`);
  return { ok: true, date, restored_jobs: jobs.length, restored_punches: punches.length };
}

/** A day's payroll rows are written — the coverage marker Tính lương reads. */
export async function markPayDay(date: string, jobs: number, punches: number, unpriced: number, source: "archive" | "reconcile") {
  await sbUpsert("pay_days", [{ trip_date: date, jobs, punches, unpriced, source, archived_at: new Date().toISOString() }], "trip_date");
}
