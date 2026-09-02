import type { Config, LogLevel, Job } from "./types";
import {
  assignJob,
  deleteJobsFromTimeline,
  getFleetwebCookie,
  getStopsByLabels,
  jsonRpc,
  getJobsByStatusAndDate,
  type Env,
} from "./cartrack";
import { isStopStarted, ENGINE_LEG_LABELS } from "./job-filters";
import { vnDate, vnMinutesSinceMidnight, parseVnTimestamp } from "./time";
import { PSC_RETURN_LABEL, PSC_OUTBOUND_LABEL, isOnShift, subToCoveredDriver, shiftMappingsForPsc } from "./return-trips";
import { PSC_VIA_LABEL } from "./via-legs";
import { claimTripAction, releaseTripClaim } from "./smart-log-kv";
import type { LeaveEntry } from "./leave-config";
import { recordCleanedReturns } from "./return-suppress";

// Reasons for removing a trip. Deleted trips keep no record, so these now read
// as the log's explanation — and still fill Cartrack's rejection record on the
// fallback path below.
const VIA_STALE_REASON = "Tài xế đã tới điểm giao - bỏ qua chặng ghé (via)";
const RETURN_STALE_REASON = "Hết ca - huỷ chuyến về chưa thực hiện";
const ROLLOVER_REASON = "Job treo qua ngày - dọn tự động";
const END_OF_DAY_REASON = "Cuối ngày - dọn chuyến về chưa hoàn thành";

// Rule D window: the engine auto-disarms at 22:00 VN and cron pings every ~3 min,
// so gating at 21:54 gives the sweep the day's LAST ~2 cycles (≈21:54 + ≈21:57):
// one clean at the end of the run plus a single retry if the first reject hiccups.
// In that window every live return trip is swept regardless of shift or started
// state — EXCEPT ones with signs of life fresher than FRESH_ACTIVITY_MS (a driver
// genuinely finishing a late return mid-ride; if they abandon it instead, the
// next-morning rollover sweep catches it).
const END_OF_DAY_FROM_MIN = 21 * 60 + 54;
const FRESH_ACTIVITY_MS = 20 * 60 * 1000;

// `suppress` is set for TODAY's return trips (Rules B and D): once we cancel one,
// the creator must not remake it for the same outbound when the shift re-opens
// later the same day. Carries the return's own from:to:driver key + create_ts.
// `date` is the VN day the job sits on — the timeline delete needs that day's
// window, and Rule C's leftovers are on YESTERDAY's timeline, not today's.
type CleanupTask = {
  jobId: number;
  date: string;
  reason: string;
  label: string;
  suppress?: { returnKey: string; createTs: string };
};

// VN date on which the yesterday-sweep last came back clean — skip re-sweeping
// until the date changes. Not set while leftovers exist, so failed rejects retry
// every cycle until yesterday's slate is actually clear.
let sweptCleanOn: string | null = null;

// Race guard across overlapping cycles, keyed by the job_id being rejected.
// L1 only — claimTripAction (Redis NX, same 60s) is the cross-instance half.
const inFlightCleanup = new Set<number>();
const IN_FLIGHT_TTL_MS = 60_000;

/** True if no stop on this job has been touched by the driver (safe to reject). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isUntouched(job: any): boolean {
  const stops: any[] = job.stops ?? []; // eslint-disable-line @typescript-eslint/no-explicit-any
  return stops.length > 0 && !stops.some((s) => isStopStarted(s));
}

/** True if the job shows signs of life within the last `windowMs`: driver
 *  activity on any stop, or the job was only just created (the creator runs in
 *  the same cycle — a fresh return the driver is about to ride must survive). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasFreshActivity(job: any, now: Date, windowMs: number): boolean {
  const stamps: (string | null | undefined)[] = [job.create_ts];
  for (const s of job.stops ?? []) {
    stamps.push(s.activity_started_ts, s.activity_arrived_ts, s.activity_completed_ts);
  }
  for (const ts of stamps) {
    if (!ts) continue;
    const t = parseVnTimestamp(ts).getTime();
    if (Number.isFinite(t) && now.getTime() - t < windowMs) return true;
  }
  return false;
}

/**
 * Remove a stale auto-created trip. Deleting is the primary path: these legs were
 * never real work, and a *rejected* one still sits in Cartrack's job list and in
 * the branch feeds as noise ops has to read past. Deleting leaves the driver's
 * day as if the leg had never been created.
 *
 * `delivery_timeline_delete_jobs` is the fleetweb map/timeline screen's own call,
 * so it removes an assigned job without the proxy-driver dance the reject needs.
 * If the delete is refused (a started or hung job can be), fall back to the old
 * reversible reject — better a rejection record than a live stale trip skewing
 * workload counts and re-triggering the sweep every cycle.
 */
async function removeTrip(
  jobId: number,
  date: string,
  reason: string,
  env: Env
): Promise<"deleted" | "rejected" | null> {
  if (await deleteJobsFromTimeline([jobId], date, env).catch(() => false)) return "deleted";
  return (await rejectJob(jobId, reason, env)) ? "rejected" : null;
}

/**
 * Reject a job the reversible way: assign to the proxy driver first (keeps the
 * rejection off the real driver's record), then JSON-RPC `delivery_reject_job`.
 * Mirrors the duplicate-rejection and /api/sales/reject-job paths. Only the
 * fallback for `removeTrip` now — deleting is preferred.
 */
async function rejectJob(jobId: number, reason: string, env: Env): Promise<boolean> {
  // Best-effort proxy assign: keeps the rejection off the real driver's record.
  // A started/hung job can refuse reassignment — proceed to the reject anyway
  // (that's exactly what the manual admin removal does in fleetweb).
  // Via assignJob, which tries the RPC first (~2.0s vs ~7.3s REST) and falls back
  // to REST itself; isProxyDriver() exempts this driver from the driver-state gate,
  // so the fast path costs no extra drivers fetch. The sweep rejects in a loop, so
  // the saving multiplies across a cleanup pass.
  const proxyDriverId = process.env.CARTRACK_REJECT_PROXY_DRIVER_ID ?? "";
  if (proxyDriverId) {
    await assignJob(proxyDriverId, jobId, env).catch(() => null);
  }

  const out = await jsonRpc("delivery_reject_job", { data: { jobIds: [jobId], rejectReason: reason } }, { env });
  return out.ok;
}

/**
 * Rule C — rolled-over leftovers. ANY engine leg from YESTERDAY — outbound, via
 * or return — still live (status 2/4) is dead weight by definition: ops end at
 * 22:00, nothing runs overnight, and the assign cycle only fetches today's date
 * window so nothing else will ever touch it. This is the "driver accidentally
 * pressed start, admin had to remove it manually the next morning" case — the
 * started-guard rightly blocks same-day rejection (a started dropoff can be a
 * real driver mid-ride), so the sweep picks it up next morning regardless of
 * started state.
 *
 * OUTBOUND legs are swept too, and unlike the other two they can be part-worked
 * — a pickup collected but never delivered. Removing the job does not lose the
 * samples, and yesterday's outbound cannot be delivered today under yesterday's
 * date anyway; the run is re-created when its route next fires. What it does
 * lose is the record of that collection, so a part-worked leftover is marked
 * ĐÃ LẤY MẪU, CHƯA GIAO in its cleanup log line rather than removed in silence.
 *
 * One label-filtered JSON-RPC call per label (prod-only); skipped for the rest
 * of the day once a sweep finds nothing to clean.
 */
async function collectRolloverTasks(env: Env): Promise<CleanupTask[]> {
  if (env !== "prod") return []; // getStopsByLabels is prod-only
  const today = vnDate();
  if (sweptCleanOn === today) return [];
  const yesterday = vnDate(new Date(Date.now() - 24 * 3600e3));

  // One single-label call per engine label, in parallel. Deliberately NOT one
  // multi-label call: the filter's AND/OR semantics are unverified, and a merged
  // query would push all three labels through the single hardcoded page of 200
  // that getStopsByLabels asks for — outbound alone is the highest-volume label.
  const perLabel = await Promise.all(
    ENGINE_LEG_LABELS.map((l) => getStopsByLabels(yesterday, [l], env)),
  );
  // Any one failing aborts the pass: a partial sweep would set sweptCleanOn for
  // the day if the labels that DID answer were clean, and the missing label's
  // leftovers would then sit untouched until tomorrow.
  if (perLabel.some((r) => !r)) return []; // fetch failed — retry next cycle

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byJob = new Map<number, any[]>();
  for (const s of perLabel.flatMap((r) => r ?? [])) {
    const arr = byJob.get(s.job_id);
    if (arr) arr.push(s);
    else byJob.set(s.job_id, [s]);
  }

  const tasks: CleanupTask[] = [];
  for (const [jobId, stops] of byJob) {
    const statusId = stops[0]?.job_status_id;
    if (statusId !== 2 && statusId !== 4) continue; // only live leftovers
    if (inFlightCleanup.has(jobId)) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickup  = stops.find((s: any) => s.stop_type_id === 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dropoff = stops.find((s: any) => s.stop_type_id === 2);
    const route = `${pickup?.customer_name ?? "?"} → ${dropoff?.customer_name ?? "?"}`;
    // A leg whose pickup was collected but whose dropoff never was is the one
    // case here that had real work done on it. It still goes — it cannot be
    // completed under yesterday's date — but it is named in the log so the
    // morning has something to read, instead of the removal being silent.
    const collected = pickup?.stop_status_id === 4 && dropoff?.stop_status_id !== 4;
    tasks.push({
      jobId,
      date: yesterday,
      reason: ROLLOVER_REASON,
      label: `Rollover #${jobId} (${yesterday}) | ${route}${collected ? " | ĐÃ LẤY MẪU, CHƯA GIAO" : ""}`,
    });
  }

  // Clean slate → don't re-sweep until tomorrow. (Left unset while leftovers
  // exist, so a failed reject is retried next cycle until yesterday is clear.)
  if (tasks.length === 0) sweptCleanOn = today;
  return tasks;
}

/**
 * Cleanup pass: delete three classes of stale auto-created PSC jobs that otherwise
 * sit on a driver and skew smart-assign workload counts. (Rejection is only the
 * fallback when a delete is refused — see `removeTrip`.)
 *
 *  A) Orphaned via-legs — an untouched via-leg whose outbound has already reached
 *     its dropoff (outbound dropoff stop_status_id 3 Arrived or 4 Completed): the
 *     driver passed the via PSC without servicing it, so the leg is dead weight.
 *  B) Stale return trips — an untouched return trip for a driver who is now off
 *     shift for that PSC (same `isOnShift` gate the creator uses, inverted).
 *  C) Rolled-over leftovers — yesterday's engine legs (outbound/via/return) still
 *     live today, including STARTED ones the same-day rules must not touch (see
 *     collectRolloverTasks). Replaces the manual next-morning admin removal.
 *  D) End-of-day return sweep — in the day's last ~2 cycles (from 21:54, engine
 *     disarms 22:00) every live return is swept, started or not, so nothing
 *     rolls overnight. Only jobs with fresh signs of life (recent activity or
 *     just created) survive — and C catches those next morning if abandoned.
 *
 * Only fires when CLEANUP_STALE_TRIPS is set. Reuses the cycle's prefetched
 * status 2/4/5 lists (no extra fetches when called from the assign cycle).
 */
export async function cleanupStaleTrips(
  config: Config,
  env: Env,
  log: (msg: string, level?: LogLevel) => void,
  prefetched?: { s2: Job[]; s4: Job[]; s5: Job[] },
  // Today's leave entries — lets Rule B gate a substitute's return on the
  // ON-LEAVE driver's shift, matching the creator. Omitted → no sub mapping.
  leaveEntries: LeaveEntry[] = [],
): Promise<void> {
  if (process.env.CLEANUP_STALE_TRIPS !== "1") return;

  const subCovers = subToCoveredDriver(config, leaveEntries); // subId → on-leave pool driver
  const today = vnDate();

  let s2: Job[];
  let s4: Job[];
  let s5: Job[];
  if (prefetched) {
    ({ s2, s4, s5 } = prefetched);
  } else {
    [s2, s4, s5] = await Promise.all([
      getJobsByStatusAndDate(2, today, env),
      getJobsByStatusAndDate(4, today, env),
      getJobsByStatusAndDate(5, today, env),
    ]);
  }

  // Index outbounds whose dropoff has been reached: "driver:dropoffCustomerId" → true.
  // Scan s4 (in-progress, dropoff may be Arrived/Completed) ∪ s5 (completed). Also index
  // each outbound by job_id → whether its dropoff is reached, so a via-leg can be matched to
  // the SPECIFIC run it belongs to (via the parent job_id appended to its reference_number).
  const reachedDropoff = new Set<string>(); // "driverId:dropoffCustomerId"
  const outboundDropoffReached = new Map<number, boolean>(); // outbound job_id → dropoff Arrived/Completed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const ob of [...s4, ...s5] as any[]) {
    if (!(ob.labels ?? []).includes(PSC_OUTBOUND_LABEL)) continue;
    if (!ob.delivery_driver_id) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dropoff = (ob.stops ?? []).find((s: any) => s.stop_type_id === 2);
    if (!dropoff?.customer_id) continue;
    const reached = dropoff.stop_status_id === 3 || dropoff.stop_status_id === 4;
    outboundDropoffReached.set(ob.job_id, reached);
    if (reached) reachedDropoff.add(`${ob.delivery_driver_id}:${dropoff.customer_id}`);
  }

  // Rule C first: yesterday's rolled-over leftovers (own fetch, disjoint from s2/s4).
  const tasks: CleanupTask[] = await collectRolloverTasks(env);

  // Candidates: untouched via-legs and return trips (created already-assigned, so
  // normally status 4; scan s2∪s4 to be safe). s5 jobs are done — never candidates.
  const now = new Date();
  // Rule D window: the day's last cycles before the 22:00 disarm.
  const endOfDay = vnMinutesSinceMidnight(now) >= END_OF_DAY_FROM_MIN;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const job of [...s2, ...s4] as any[]) {
    const labels: string[] = job.labels ?? [];
    const isVia = labels.includes(PSC_VIA_LABEL);
    const isReturn = labels.includes(PSC_RETURN_LABEL);
    if (!isVia && !isReturn) continue;
    if (job.job_status_id === 3 || job.job_status_id === 7) continue; // already cancelled/rejected
    if (!job.delivery_driver_id) continue;
    // NOTE: the untouched guard is per-rule now — Rule D (end-of-day) sweeps
    // started returns too, which Rules A/B must never touch.
    const untouched = isUntouched(job);
    if (inFlightCleanup.has(job.job_id)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickup  = (job.stops ?? []).find((s: any) => s.stop_type_id === 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dropoff = (job.stops ?? []).find((s: any) => s.stop_type_id === 2);
    if (!pickup?.customer_id || !dropoff?.customer_id) continue;

    const driverId: string = job.delivery_driver_id;
    const route = `${pickup.customer_name ?? pickup.customer_id} → ${dropoff.customer_name ?? dropoff.customer_id}`;
    // The timeline delete needs the day the job actually sits on. s2/s4 are today's
    // window, but read the job's own scheduled date when it has one.
    const date = (job.scheduled_delivery_ts as string | undefined)?.slice(0, 10) || today;
    // Same orientation the creator keys returns by: from (lab) : to (PSC) : driver.
    const suppress = job.create_ts
      ? { returnKey: `${pickup.customer_id}:${dropoff.customer_id}:${driverId}`, createTs: job.create_ts as string }
      : undefined;

    if (isVia) {
      if (!untouched) continue; // never touch a started via-leg
      // Rule A: a via-leg is orphaned only when the SPECIFIC run it belongs to has reached the
      // dropoff (or that run is gone). The parent outbound's job_id is appended to the via-leg's
      // reference ("…_HH:MM_<jobId>") — match on it so a hub dropoff (e.g. D001) reached by an
      // *unrelated* run no longer triggers a wrongful cancel→recreate loop.
      const m = /_(\d+)$/.exec(job.reference_number ?? "");
      if (m) {
        const parentReached = outboundDropoffReached.get(Number(m[1]));
        if (parentReached === false) continue; // parent run still live → keep the leg
        // parentReached === true (reached the lab) or undefined (run gone) → orphaned.
      } else if (!reachedDropoff.has(`${driverId}:${dropoff.customer_id}`)) {
        continue; // legacy via-leg with no parent id → fall back to the coarse check
      }
      tasks.push({ jobId: job.job_id, date, reason: VIA_STALE_REASON, label: `Via-leg #${job.job_id} | ${route}` });
    } else if (endOfDay) {
      // Rule D: end-of-day sweep — the day's last cycles. Every live return goes,
      // started or not, on or off shift, so nothing rolls over to tomorrow. Only a
      // return with FRESH driver activity survives (genuinely finishing a late
      // ride); if that one gets abandoned, the morning rollover sweep takes it.
      if (hasFreshActivity(job, now, FRESH_ACTIVITY_MS)) continue;
      tasks.push({ jobId: job.job_id, date, reason: END_OF_DAY_REASON, label: `Return (EOD) #${job.job_id} | ${route}`, suppress });
    } else {
      if (!untouched) continue; // started same-day return: could be mid-ride — Rule D/C handle it
      // Rule B: the return's dropoff (stop_type_id 2) is the PSC. Off shift there?
      // For a substitute, count their own window here AND the covered driver's —
      // the same union the creator uses, so the two gates stay mirror images.
      const pscCustomerId: string = dropoff.customer_id;
      const driverMappings = shiftMappingsForPsc(config, pscCustomerId, driverId, subCovers);
      // Same gate as the creator, inverted: a mapping exists and none is on shift.
      if (!(driverMappings.length > 0 && !driverMappings.some((m) => isOnShift(m, now)))) continue;
      tasks.push({ jobId: job.job_id, date, reason: RETURN_STALE_REASON, label: `Return #${job.job_id} | ${route}`, suppress });
    }
  }

  if (tasks.length === 0) return;

  // Pre-flight the login (cached, so this is the same session removeTrip will use):
  // no session means every delete below would fail — say so once, not N times.
  if (!(await getFleetwebCookie(env))) {
    log(`Cleanup: ${tasks.length} stale job(s) found but no fleetweb cookie to delete them`, "WARN");
    return;
  }

  // Claim all guards before any POST so overlapping cycles don't double-delete.
  // claimTripAction extends the guard across instances and deployments; a job
  // already claimed elsewhere drops out of this pass rather than being deleted
  // twice, and comes back next cycle if it still qualifies.
  const claimed: CleanupTask[] = [];
  for (const t of tasks) {
    if (!(await claimTripAction("cleanup", t.jobId, env))) continue;
    inFlightCleanup.add(t.jobId);
    setTimeout(() => inFlightCleanup.delete(t.jobId), IN_FLIGHT_TTL_MS);
    claimed.push(t);
  }
  if (claimed.length === 0) return;

  // Routes actually cancelled this pass — remembered so the creator doesn't remake
  // them when the driver's shift re-opens later today.
  const cleaned: Array<{ returnKey: string; createTs: string }> = [];

  // Bounded concurrency (5), same as the via/return detectors.
  for (let i = 0; i < claimed.length; i += 5) {
    await Promise.all(
      claimed.slice(i, i + 5).map(async (t) => {
        try {
          const outcome = await removeTrip(t.jobId, t.date, t.reason, env);
          const verb =
            outcome === "deleted" ? "deleted" : outcome === "rejected" ? "rejected (delete refused)" : "FAILED";
          log(`Cleanup ${verb} ${t.label}`, outcome ? "WARN" : "ERROR");
          if (outcome) {
            if (t.suppress) cleaned.push(t.suppress);
          } else {
            inFlightCleanup.delete(t.jobId); // allow retry next cycle
            await releaseTripClaim("cleanup", t.jobId, env);
          }
        } catch (e) {
          log(`Cleanup failed for ${t.label}: ${e}`, "ERROR");
          inFlightCleanup.delete(t.jobId);
          await releaseTripClaim("cleanup", t.jobId, env);
        }
      })
    );
  }

  // Never let a bookkeeping failure break the cleanup pass.
  await recordCleanedReturns(cleaned).catch((e) =>
    log(`Cleanup: could not record cancelled returns (they may be recreated): ${e}`, "WARN"),
  );
}
