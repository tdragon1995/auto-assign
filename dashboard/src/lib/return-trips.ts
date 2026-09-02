import type { Config, Mapping, LogLevel, Job } from "./types";
import { createJob, friendlyCreateError, isDriverUnavailableError, getJobsByStatusAndDate, type Env } from "./cartrack";
import { vnDate, vnHoursMinutes, parseVnTimestamp } from "./time";
import { isDriverOnLeave, resolveSubstitute, type LeaveEntry } from "./leave-config";
import { loadCleanedReturns } from "./return-suppress";
import { claimTripAction, releaseTripClaim } from "./smart-log-kv";
import { PSC_RETURN_LABEL, PSC_OUTBOUND_LABEL } from "./job-filters";

// Race-condition guard across overlapping 30s cycles. L1 only — it guards this
// lambda. The cross-instance half is claimTripAction (Redis NX, same 60s), which
// is what lets the engine run from more than one deployment at a time.
const inFlightReturns = new Set<number>(); // keyed by outbound job_id
const IN_FLIGHT_TTL_MS = 60_000;

export function isOnShift(mapping: Mapping, now: Date): boolean {
  const { shift_start, shift_end } = mapping;
  if (!shift_start || !shift_end) return true;
  const { hours, minutes } = vnHoursMinutes(now);
  const nowMin = hours * 60 + minutes;
  const startMin = shift_start.hours * 60 + shift_start.minutes;
  const endMin = shift_end.hours * 60 + shift_end.minutes;
  if (startMin > endMin) return nowMin > startMin || nowMin <= endMin;
  return nowMin > startMin && nowMin <= endMin;
}

function shortName(name: string): string {
  return name.replace(/^BRA\s*-\s*/i, "");
}

function hhmm(): string {
  const { hours, minutes } = vnHoursMinutes();
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

type CreateReturnOutcome =
  | { ok: true; jobId: number }
  | { ok: false; unavailable: boolean; message: string };

async function createReturnJob(
  driverId: string,
  fromCustomerId: string,
  fromCustomerName: string,
  toCustomerId: string,
  toCustomerName: string,
  env: Env
): Promise<CreateReturnOutcome> {
  const payload = {
    job_type_id: 1,
    schedule_type_id: 1,
    reference_number: `${shortName(fromCustomerName)}→${shortName(toCustomerName)}_${hhmm()}`,
    labels: [PSC_RETURN_LABEL],
    delivery_driver_id: driverId, // assign at creation — single call (no separate assignJob)
    stops: [
      {
        stop_type_id: 1,
        customer_id: fromCustomerId,
        duration: 5,
        todos: [],
      },
      {
        stop_type_id: 2,
        customer_id: toCustomerId,
        duration: 10,
        todos: [
          { todo_type_id: 2, description: "📦 Chụp vật tư / tài liệu (nếu có)" },
        ],
      },
    ],
    items: [
      {
        description: "📦 Vật tư / tài liệu",
        weight: 0,
        item_type_id: 1,
        quantity: 1,
        tracking_number: "",
        todos: [
          { todo_type_id: 5, stop_type_id: 2, is_required: true, description: "👤 Người nhận" },
        ],
      },
    ],
  };

  const res = await createJob(payload, env);

  if (!res.ok) {
    return { ok: false, unavailable: isDriverUnavailableError(res.body), message: friendlyCreateError(res.body) };
  }

  const json = res.body;
  const jobId = json.data?.job_id;
  if (!jobId) throw new Error("createReturnJob: no job_id in response");
  if (json.data?.delivery_driver_id !== driverId) {
    throw new Error(`createReturnJob: job ${jobId} created but not assigned to ${driverId}`);
  }
  return { ok: true, jobId: jobId as number };
}

/**
 * Map each substitute currently covering an on-leave smart-pool driver → the
 * pool driver they cover. The sub holds that driver's outbounds today, so both
 * the return-trip creator and the cleanup pass count the ON-LEAVE driver's shift
 * window when deciding the sub's return.
 *
 * Note both callers add the covered driver's window to the sub's OWN one rather
 * than replacing it. The original "a sub has no mapping of their own here" premise
 * is false often enough to matter — a driver can cover someone at one branch while
 * running their own roster at another — and replacing left them with no window at
 * all wherever the covered driver isn't mapped.
 */
export function subToCoveredDriver(
  config: Config,
  leaveEntries: LeaveEntry[],
): Map<string, string> {
  const map = new Map<string, string>(); // subId → on-leave pool driver id
  const poolIds = new Set(config.mappings.flatMap((m) => m.smart_driver_id));
  for (const id of poolIds) {
    const lc = isDriverOnLeave(id, leaveEntries);
    if (!lc.onLeave) continue;
    const sub = resolveSubstitute(lc.entry!);
    if (sub.status === "ok") map.set(sub.subId, id);
  }
  return map;
}

/**
 * The shift windows that govern one driver's return trip at one PSC: their own
 * mappings there, PLUS those of whoever they are covering today. A union, not a
 * replacement — see {@link subToCoveredDriver}.
 *
 * Both gates call this so they cannot drift apart: the creator refuses to build a
 * return when no window is open, and the cleanup pass cancels one when this same
 * set says the driver is off shift. An empty result means "this driver has no
 * mapping here at all" and leaves the decision to the caller.
 */
export function shiftMappingsForPsc(
  config: Config,
  pscCustomerId: string,
  driverId: string,
  subCovers: Map<string, string>,
): Mapping[] {
  const coveredDriverId = subCovers.get(driverId);
  const ids = coveredDriverId ? [driverId, coveredDriverId] : [driverId];
  return config.mappings.filter(
    (m) =>
      m.customer_id === pscCustomerId &&
      ids.some((id) => m.driver_id === id || m.smart_driver_id.includes(id)),
  );
}

export async function detectAndCreateReturnTrips(
  config: Config,
  env: Env,
  log: (msg: string, level?: LogLevel) => void,
  // Pre-fetched today's status-2/4/5 lists shared by the cycle. When omitted
  // (e.g. standalone call), fetch them here.
  prefetched?: { s2: Job[]; s4: Job[]; s5: Job[] },
  // Today's leave entries — used to also cover substitutes (see below). Omitted
  // standalone → no sub widening, just the raw pool.
  leaveEntries: LeaveEntry[] = [],
): Promise<void> {
  // Only applies to drivers in any smart-assign pool (pilot gate)
  const allSmartDriverIds = new Set(config.mappings.flatMap((m) => m.smart_driver_id));
  // ...plus any substitute currently covering an on-leave pool driver: the sub
  // holds that driver's outbounds today, so they must get the return leg too —
  // otherwise a covered route silently loses its return trip.
  const subCovers = subToCoveredDriver(config, leaveEntries); // subId → on-leave pool driver
  for (const subId of subCovers.keys()) allSmartDriverIds.add(subId);

  let completedJobs: Job[];
  let activeStatus2: Job[];
  let activeStatus4: Job[];
  if (prefetched) {
    completedJobs = prefetched.s5;
    activeStatus2 = prefetched.s2;
    activeStatus4 = prefetched.s4;
  } else {
    const today = vnDate();
    [completedJobs, activeStatus2, activeStatus4] = await Promise.all([
      getJobsByStatusAndDate(5, today, env),
      getJobsByStatusAndDate(2, today, env),
      getJobsByStatusAndDate(4, today, env),
    ]);
  }

  // Split completed jobs into outbounds and completed returns (same fetch, no extra API call).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const completedReturns = (completedJobs as any[]).filter(
    (j) => (j.labels ?? []).includes(PSC_RETURN_LABEL) && j.delivery_driver_id && j.create_ts
  );

  // Index completed returns: "fromId:toId:driverId" → sorted create_ts strings.
  // Used to detect outbounds that were already handled: a return created AFTER the outbound's
  // dropoff completion means that outbound has been processed — skip it even if the return is now done.
  const completedReturnIndex = new Map<string, string[]>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const ret of completedReturns as any[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rPickup  = (ret.stops ?? []).find((s: any) => s.stop_type_id === 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rDropoff = (ret.stops ?? []).find((s: any) => s.stop_type_id === 2);
    if (!rPickup?.customer_id || !rDropoff?.customer_id) continue;
    const key = `${rPickup.customer_id}:${rDropoff.customer_id}:${ret.delivery_driver_id}`;
    const arr = completedReturnIndex.get(key) ?? [];
    arr.push(ret.create_ts as string);
    completedReturnIndex.set(key, arr);
  }

  // Returns the cleanup pass already REJECTED today (status 3/7) are invisible to
  // the status 2/4/5 lists above, but they were still "made" for their outbound.
  // Fold them into the same index so a shift that re-opens later the same day
  // doesn't resurrect a return we deliberately cancelled at the end of the shift.
  for (const [key, createTs] of await loadCleanedReturns()) {
    const arr = completedReturnIndex.get(key) ?? [];
    arr.push(createTs);
    completedReturnIndex.set(key, arr);
  }

  // Build set of from:to:driver keys that already have an active return trip (status 2 or 4).
  // Per-driver so two drivers completing the same route each get their own return.
  const blockingReturnKeys = new Set<string>(); // "fromId:toId:driverId"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const job of [...activeStatus2, ...activeStatus4] as any[]) {
    const labels: string[] = job.labels ?? [];
    if (!labels.includes(PSC_RETURN_LABEL)) continue;
    if (!job.delivery_driver_id) continue; // unassigned — can't key by driver, skip
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickupStop = (job.stops ?? []).find((s: any) => s.stop_type_id === 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dropoffStop = (job.stops ?? []).find((s: any) => s.stop_type_id === 2);
    if (pickupStop?.customer_id && dropoffStop?.customer_id) {
      blockingReturnKeys.add(`${pickupStop.customer_id}:${dropoffStop.customer_id}:${job.delivery_driver_id}`);
    }
  }

  const createTasks: Array<() => Promise<void>> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const outbound of completedJobs as any[]) {
    const labels: string[] = outbound.labels ?? [];
    if (!labels.includes(PSC_OUTBOUND_LABEL)) continue;
    if (labels.includes(PSC_RETURN_LABEL)) continue;
    if (!outbound.delivery_driver_id) continue;
    if (!allSmartDriverIds.has(outbound.delivery_driver_id)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickupStop = (outbound.stops ?? []).find((s: any) => s.stop_type_id === 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dropoffStop = (outbound.stops ?? []).find((s: any) => s.stop_type_id === 2);

    if (!pickupStop?.customer_id || !dropoffStop?.customer_id) continue;

    // Shift check for the PSC the driver just serviced. A substitute is judged on
    // BOTH their own window here and the covered driver's. Swapping in the covered
    // driver ALONE left the sub with no window wherever that driver isn't mapped —
    // and no window skips the gate below entirely, so the return was rebuilt at any
    // hour until the end-of-day sweep. That is not hypothetical: D014 has four fixed
    // drivers and no pool, so a sub covering a pool driver matched nothing there.
    const pscCustomerId: string = pickupStop.customer_id;
    const driverMappings = shiftMappingsForPsc(config, pscCustomerId, outbound.delivery_driver_id, subCovers);
    const now = new Date();

    // A return trip belongs to the shift the OUTBOUND was finished in. So we need
    // ONE shift window that was open when the driver completed the outbound AND is
    // still open now — not merely "some window is open now".
    //
    // Gating on `now` alone leaked returns hours later, because a completed outbound
    // sits at status 5 for the rest of the day and re-triggers this scan every cycle.
    // Two cases that produced, both now blocked:
    //   • driver finishes an outbound AFTER his shift closed → no return, and none
    //     appears when a later window opens the same day;
    //   • driver finishes just before the window closes and the window shuts before
    //     the next cycle → the return stays uncreated instead of surfacing later.
    const doneTs: string | null = dropoffStop.activity_completed_ts ?? null;
    const doneAt = doneTs ? parseVnTimestamp(doneTs) : null;
    if (driverMappings.length > 0) {
      const openNow = driverMappings.filter((m) => isOnShift(m, now));
      if (openNow.length === 0) continue;
      // No completion stamp → fall back to the "on shift now" gate alone.
      if (doneAt && Number.isFinite(doneAt.getTime()) && !openNow.some((m) => isOnShift(m, doneAt))) continue;
    }

    // Return trip is the inverse: from where the outbound ended, back to the PSC
    const fromCustomerId: string = dropoffStop.customer_id;
    const fromCustomerName: string = dropoffStop.customer_name ?? dropoffStop.name ?? fromCustomerId;
    const toCustomerId: string = pickupStop.customer_id;
    const toCustomerName: string = pickupStop.customer_name ?? pickupStop.name ?? toCustomerId;

    const returnKey = `${fromCustomerId}:${toCustomerId}:${outbound.delivery_driver_id}`;

    // Skip if a completed return already exists that was created AFTER this outbound's dropoff finished.
    // "YYYY-MM-DD HH:MM:SS" string comparison works for same-day Cartrack timestamps.
    const outboundDoneAt: string = (doneTs ?? "").slice(0, 19);
    if (outboundDoneAt) {
      const priorReturns = completedReturnIndex.get(returnKey) ?? [];
      if (priorReturns.some((ts) => ts.slice(0, 19) > outboundDoneAt)) continue;
    }

    if (blockingReturnKeys.has(returnKey)) continue;
    if (inFlightReturns.has(outbound.job_id)) continue;
    // Every check above is derived from Cartrack's job list, which lags a create
    // by a few seconds. Claim across instances before committing to the POST.
    if (!(await claimTripAction("return", outbound.job_id, env))) continue;

    inFlightReturns.add(outbound.job_id);
    setTimeout(() => inFlightReturns.delete(outbound.job_id), IN_FLIGHT_TTL_MS);
    blockingReturnKeys.add(returnKey); // protect same driver in same cycle

    createTasks.push(async () => {
      try {
        const result = await createReturnJob(outbound.delivery_driver_id, fromCustomerId, fromCustomerName, toCustomerId, toCustomerName, env);
        if (result.ok) {
          log(`Return trip #${result.jobId} : driver (from outbound ${outbound.job_id}) | ${fromCustomerName} → ${toCustomerName}`, "OK");
          return;
        }
        // On-break/offline is an expected end-of-shift state, not a bug — WARN,
        // not ERROR, and a message a dispatcher can read without JSON.
        log(
          `Return trip ${result.unavailable ? "skipped" : "failed"} for outbound ${outbound.job_id}: ${result.message} | ${fromCustomerName} → ${toCustomerName}`,
          result.unavailable ? "WARN" : "ERROR"
        );
        inFlightReturns.delete(outbound.job_id);
        blockingReturnKeys.delete(returnKey); // allow retry next cycle
        await releaseTripClaim("return", outbound.job_id, env);
      } catch (e) {
        log(`Return trip failed for outbound ${outbound.job_id}: ${e} | ${fromCustomerName} → ${toCustomerName}`, "ERROR");
        inFlightReturns.delete(outbound.job_id);
        blockingReturnKeys.delete(returnKey); // allow retry next cycle
        await releaseTripClaim("return", outbound.job_id, env);
      }
    });
  }

  // Fire the creations concurrently (bounded 5). Guards above were set
  // synchronously during the scan, so dedup is fully resolved before any POST.
  for (let i = 0; i < createTasks.length; i += 5) {
    await Promise.all(createTasks.slice(i, i + 5).map((t) => t()));
  }
}
