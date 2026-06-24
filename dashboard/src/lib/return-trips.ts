import type { Config, Mapping, LogLevel, Job } from "./types";
import { BASE_URL, getHeaders, getJobsByStatusAndDate, type Env } from "./cartrack";
import { vnDate, vnHoursMinutes } from "./time";

export const PSC_RETURN_LABEL = "🛵 Vận chuyển mẫu PSC (về)";
export const PSC_OUTBOUND_LABEL = "🛵 Vận chuyển mẫu PSC";

// Race-condition guard across overlapping 30s cycles
const inFlightReturns = new Set<number>(); // keyed by outbound job_id
const IN_FLIGHT_TTL_MS = 60_000;

function isOnShift(mapping: Mapping, now: Date): boolean {
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

async function createReturnJob(
  driverId: string,
  fromCustomerId: string,
  fromCustomerName: string,
  toCustomerId: string,
  toCustomerName: string,
  env: Env
): Promise<number> {
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

  const res = await fetch(`${BASE_URL}/jobs`, {
    method: "POST",
    headers: getHeaders(env),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`createReturnJob failed: ${res.status} ${JSON.stringify(err)}`);
  }

  const json = await res.json();
  const jobId = json.data?.job_id;
  if (!jobId) throw new Error("createReturnJob: no job_id in response");
  if (json.data?.delivery_driver_id !== driverId) {
    throw new Error(`createReturnJob: job ${jobId} created but not assigned to ${driverId}`);
  }
  return jobId as number;
}

export async function detectAndCreateReturnTrips(
  config: Config,
  env: Env,
  log: (msg: string, level?: LogLevel) => void,
  // Pre-fetched today's status-2/4/5 lists shared by the cycle. When omitted
  // (e.g. standalone call), fetch them here.
  prefetched?: { s2: Job[]; s4: Job[]; s5: Job[] },
): Promise<void> {
  // Only applies to drivers in any smart-assign pool (pilot gate)
  const allSmartDriverIds = new Set(config.mappings.flatMap((m) => m.smart_driver_id));

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

    // Shift check: driver must be on shift right now for the PSC they just serviced
    const pscCustomerId: string = pickupStop.customer_id;
    const driverMappings = config.mappings.filter(
      (m) =>
        m.customer_id === pscCustomerId &&
        (m.driver_id === outbound.delivery_driver_id ||
          m.smart_driver_id.includes(outbound.delivery_driver_id))
    );
    const now = new Date();
    if (driverMappings.length > 0 && !driverMappings.some((m) => isOnShift(m, now))) continue;

    // Return trip is the inverse: from where the outbound ended, back to the PSC
    const fromCustomerId: string = dropoffStop.customer_id;
    const fromCustomerName: string = dropoffStop.customer_name ?? dropoffStop.name ?? fromCustomerId;
    const toCustomerId: string = pickupStop.customer_id;
    const toCustomerName: string = pickupStop.customer_name ?? pickupStop.name ?? toCustomerId;

    const returnKey = `${fromCustomerId}:${toCustomerId}:${outbound.delivery_driver_id}`;

    // Skip if a completed return already exists that was created AFTER this outbound's dropoff finished.
    // "YYYY-MM-DD HH:MM:SS" string comparison works for same-day Cartrack timestamps.
    const outboundDoneAt: string = (dropoffStop.activity_completed_ts ?? "").slice(0, 19);
    if (outboundDoneAt) {
      const priorReturns = completedReturnIndex.get(returnKey) ?? [];
      if (priorReturns.some((ts) => ts.slice(0, 19) > outboundDoneAt)) continue;
    }

    if (blockingReturnKeys.has(returnKey)) continue;
    if (inFlightReturns.has(outbound.job_id)) continue;

    inFlightReturns.add(outbound.job_id);
    setTimeout(() => inFlightReturns.delete(outbound.job_id), IN_FLIGHT_TTL_MS);
    blockingReturnKeys.add(returnKey); // protect same driver in same cycle

    createTasks.push(async () => {
      try {
        const newJobId = await createReturnJob(outbound.delivery_driver_id, fromCustomerId, fromCustomerName, toCustomerId, toCustomerName, env);
        log(`Return trip #${newJobId} : driver (from outbound ${outbound.job_id}) | ${fromCustomerName} → ${toCustomerName}`, "OK");
      } catch (e) {
        log(`Return trip failed for outbound ${outbound.job_id}: ${e} | ${fromCustomerName} → ${toCustomerName}`, "ERROR");
        inFlightReturns.delete(outbound.job_id);
        blockingReturnKeys.delete(returnKey); // allow retry next cycle
      }
    });
  }

  // Fire the creations concurrently (bounded 5). Guards above were set
  // synchronously during the scan, so dedup is fully resolved before any POST.
  for (let i = 0; i < createTasks.length; i += 5) {
    await Promise.all(createTasks.slice(i, i + 5).map((t) => t()));
  }
}
