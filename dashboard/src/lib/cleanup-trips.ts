import type { Config, LogLevel, Job } from "./types";
import { BASE_URL, getHeaders, getFleetwebCookie, JSONRPC_URL, getJobsByStatusAndDate, type Env } from "./cartrack";
import { isStopStarted } from "./job-filters";
import { vnDate } from "./time";
import { PSC_RETURN_LABEL, PSC_OUTBOUND_LABEL, isOnShift, subToCoveredDriver } from "./return-trips";
import { PSC_VIA_LABEL } from "./via-legs";
import type { LeaveEntry } from "./leave-config";

// Reject reasons surfaced in Cartrack's rejection record.
const VIA_STALE_REASON = "Tài xế đã tới điểm giao - bỏ qua chặng ghé (via)";
const RETURN_STALE_REASON = "Hết ca - huỷ chuyến về chưa thực hiện";

// Race guard across overlapping cycles, keyed by the job_id being rejected.
const inFlightCleanup = new Set<number>();
const IN_FLIGHT_TTL_MS = 60_000;

/** True if no stop on this job has been touched by the driver (safe to reject). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isUntouched(job: any): boolean {
  const stops: any[] = job.stops ?? []; // eslint-disable-line @typescript-eslint/no-explicit-any
  return stops.length > 0 && !stops.some((s) => isStopStarted(s));
}

/**
 * Reject a job the reversible way: assign to the proxy driver first (keeps the
 * rejection off the real driver's record), then JSON-RPC `delivery_reject_job`.
 * Mirrors the duplicate-rejection and /api/sales/reject-job paths — never deleteJob.
 */
async function rejectJob(jobId: number, reason: string, env: Env, cookie: string): Promise<boolean> {
  const headers = getHeaders(env);
  const proxyDriverId = process.env.CARTRACK_REJECT_PROXY_DRIVER_ID ?? "";
  if (!proxyDriverId) return false;

  const assignRes = await fetch(`${BASE_URL}/jobs/${jobId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ delivery_driver_id: proxyDriverId }),
    cache: "no-store",
  });
  if (!assignRes.ok) return false;

  const rpcRes = await fetch(JSONRPC_URL, {
    method: "POST",
    headers: { ...headers, Cookie: cookie },
    body: JSON.stringify({
      version: "2.0",
      method: "delivery_reject_job",
      id: 1,
      params: { data: { jobIds: [jobId], rejectReason: reason } },
    }),
  });
  const rpcData = await rpcRes.json().catch(() => ({}));
  return rpcRes.ok && !rpcData.error;
}

/**
 * Cleanup pass: reject (never delete) two classes of stale auto-created PSC jobs
 * that otherwise sit on a driver and skew smart-assign workload counts.
 *
 *  A) Orphaned via-legs — an untouched via-leg whose outbound has already reached
 *     its dropoff (outbound dropoff stop_status_id 3 Arrived or 4 Completed): the
 *     driver passed the via PSC without servicing it, so the leg is dead weight.
 *  B) Stale return trips — an untouched return trip for a driver who is now off
 *     shift for that PSC (same `isOnShift` gate the creator uses, inverted).
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

  let s2: Job[];
  let s4: Job[];
  let s5: Job[];
  if (prefetched) {
    ({ s2, s4, s5 } = prefetched);
  } else {
    const today = vnDate();
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

  // Candidates: untouched via-legs and return trips (created already-assigned, so
  // normally status 4; scan s2∪s4 to be safe). s5 jobs are done — never candidates.
  const now = new Date();
  type RejectTask = { jobId: number; reason: string; label: string };
  const tasks: RejectTask[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const job of [...s2, ...s4] as any[]) {
    const labels: string[] = job.labels ?? [];
    const isVia = labels.includes(PSC_VIA_LABEL);
    const isReturn = labels.includes(PSC_RETURN_LABEL);
    if (!isVia && !isReturn) continue;
    if (job.job_status_id === 3 || job.job_status_id === 7) continue; // already cancelled/rejected
    if (!job.delivery_driver_id) continue;
    if (!isUntouched(job)) continue;
    if (inFlightCleanup.has(job.job_id)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickup  = (job.stops ?? []).find((s: any) => s.stop_type_id === 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dropoff = (job.stops ?? []).find((s: any) => s.stop_type_id === 2);
    if (!pickup?.customer_id || !dropoff?.customer_id) continue;

    const driverId: string = job.delivery_driver_id;
    const route = `${pickup.customer_name ?? pickup.customer_id} → ${dropoff.customer_name ?? dropoff.customer_id}`;

    if (isVia) {
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
      tasks.push({ jobId: job.job_id, reason: VIA_STALE_REASON, label: `Via-leg #${job.job_id} | ${route}` });
    } else {
      // Rule B: the return's dropoff (stop_type_id 2) is the PSC. Off shift there?
      // For a substitute, gate on the ON-LEAVE driver's shift (matches the creator).
      const pscCustomerId: string = dropoff.customer_id;
      const shiftDriverId = subCovers.get(driverId) ?? driverId;
      const driverMappings = config.mappings.filter(
        (m) =>
          m.customer_id === pscCustomerId &&
          (m.driver_id === shiftDriverId || m.smart_driver_id.includes(shiftDriverId))
      );
      // Same gate as the creator, inverted: a mapping exists and none is on shift.
      if (!(driverMappings.length > 0 && !driverMappings.some((m) => isOnShift(m, now)))) continue;
      tasks.push({ jobId: job.job_id, reason: RETURN_STALE_REASON, label: `Return #${job.job_id} | ${route}` });
    }
  }

  if (tasks.length === 0) return;

  const cookie = await getFleetwebCookie();
  if (!cookie) {
    log(`Cleanup: ${tasks.length} stale job(s) found but no fleetweb cookie to reject`, "WARN");
    return;
  }

  // Claim all guards synchronously before any POST so overlapping cycles don't double-reject.
  for (const t of tasks) {
    inFlightCleanup.add(t.jobId);
    setTimeout(() => inFlightCleanup.delete(t.jobId), IN_FLIGHT_TTL_MS);
  }

  // Bounded concurrency (5), same as the via/return detectors.
  for (let i = 0; i < tasks.length; i += 5) {
    await Promise.all(
      tasks.slice(i, i + 5).map(async (t) => {
        try {
          const ok = await rejectJob(t.jobId, t.reason, env, cookie);
          log(`Cleanup rejected ${t.label} — ${ok ? "OK" : "FAILED"}`, ok ? "WARN" : "ERROR");
          if (!ok) inFlightCleanup.delete(t.jobId); // allow retry next cycle
        } catch (e) {
          log(`Cleanup failed for ${t.label}: ${e}`, "ERROR");
          inFlightCleanup.delete(t.jobId);
        }
      })
    );
  }
}
