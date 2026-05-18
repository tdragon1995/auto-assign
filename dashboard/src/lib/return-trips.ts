import type { Config, LogLevel } from "./types";
import { BASE_URL, getHeaders, getJobsByStatusAndDate, assignJob, type Env } from "./cartrack";
import { vnDate, vnHoursMinutes } from "./time";

export const PSC_RETURN_LABEL = "🛵 Vận chuyển mẫu PSC (về)";
const PSC_OUTBOUND_LABEL = "🛵 Vận chuyển mẫu PSC";

// Race-condition guard across overlapping 30s cycles
const inFlightReturns = new Set<number>(); // keyed by outbound job_id
const IN_FLIGHT_TTL_MS = 60_000;

function shortName(name: string): string {
  return name.replace(/^BRA\s*-\s*/i, "");
}

function hhmm(): string {
  const { hours, minutes } = vnHoursMinutes();
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

async function createReturnJob(
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
    stops: [
      {
        stop_type_id: 1,
        customer_id: fromCustomerId,
        customer_name: fromCustomerName,
        duration: 5,
        todos: [
          { todo_type_id: 2, description: "📦 Chụp vật tư / tài liệu đã đóng gói" },
          { todo_type_id: 2, description: "✍️ Chụp phiếu bàn giao đã ký" },
        ],
      },
      {
        stop_type_id: 2,
        customer_id: toCustomerId,
        customer_name: toCustomerName,
        duration: 10,
        todos: [
          { todo_type_id: 2, description: "📋 Chụp vật tư đã giao thấy rõ" },
          { todo_type_id: 2, description: "🤝 Chụp người nhận tại PSC" },
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
  return jobId as number;
}

export async function detectAndCreateReturnTrips(
  config: Config,
  env: Env,
  log: (msg: string, level?: LogLevel) => void
): Promise<void> {
  // Only applies to drivers in any smart-assign pool (pilot gate)
  const allSmartDriverIds = new Set(config.mappings.flatMap((m) => m.smart_driver_id));

  const today = vnDate();

  const [completedJobs, activeStatus2, activeStatus4] = await Promise.all([
    getJobsByStatusAndDate(5, today, env),
    getJobsByStatusAndDate(2, today, env),
    getJobsByStatusAndDate(4, today, env),
  ]);

  // Build set of from:to pairs that already have an active return trip (status 2 or 4).
  // Status 5/3/7 (done/failed/cancelled) intentionally excluded — allows new returns for subsequent outbounds.
  const blockingReturnPairs = new Set<string>(); // "fromId:toId"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const job of [...activeStatus2, ...activeStatus4] as any[]) {
    const labels: string[] = job.labels ?? [];
    if (!labels.includes(PSC_RETURN_LABEL)) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickupStop = (job.stops ?? []).find((s: any) => s.stop_type_id === 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dropoffStop = (job.stops ?? []).find((s: any) => s.stop_type_id === 2);
    if (pickupStop?.customer_id && dropoffStop?.customer_id) {
      blockingReturnPairs.add(`${pickupStop.customer_id}:${dropoffStop.customer_id}`);
    }
  }

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

    // Return trip is the inverse: from where the outbound ended, back to the PSC
    const fromCustomerId: string = dropoffStop.customer_id;
    const fromCustomerName: string = dropoffStop.customer_name ?? dropoffStop.name ?? fromCustomerId;
    const toCustomerId: string = pickupStop.customer_id;
    const toCustomerName: string = pickupStop.customer_name ?? pickupStop.name ?? toCustomerId;

    const pairKey = `${fromCustomerId}:${toCustomerId}`;
    if (blockingReturnPairs.has(pairKey)) continue;
    if (inFlightReturns.has(outbound.job_id)) continue;

    inFlightReturns.add(outbound.job_id);
    setTimeout(() => inFlightReturns.delete(outbound.job_id), IN_FLIGHT_TTL_MS);
    blockingReturnPairs.add(pairKey); // protect later iterations in same cycle

    try {
      const newJobId = await createReturnJob(fromCustomerId, fromCustomerName, toCustomerId, toCustomerName, env);
      await assignJob(outbound.delivery_driver_id, newJobId, env);
      log(`Return trip ${shortName(fromCustomerName)}→${shortName(toCustomerName)} → driver (from outbound ${outbound.job_id})`, "OK");
    } catch (e) {
      log(`Return trip failed for outbound ${outbound.job_id}: ${e}`, "ERROR");
      inFlightReturns.delete(outbound.job_id);
      blockingReturnPairs.delete(pairKey); // allow retry next cycle
    }
  }
}
