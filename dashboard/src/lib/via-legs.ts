import type { LogLevel } from "./types";
import { BASE_URL, getHeaders, getJobsByStatusAndDate, type Env } from "./cartrack";
import { vnDate, vnHoursMinutes, vnTimestamp } from "./time";
import { loadPscRoutes } from "./psc-config";
import { PSC_OUTBOUND_LABEL } from "./return-trips";

// Distinct from PSC_OUTBOUND_LABEL on purpose: the return detector only inverts
// outbound-labelled jobs, so a via-leg with this label does NOT spawn a D001→via
// return. The via PSC's inbound is delivered informally on the next outbound run.
export const PSC_VIA_LABEL = "🛵 Vận chuyển mẫu PSC (ghé)";

// Race guard across overlapping cycles, keyed by the triggering outbound job_id.
const inFlightVia = new Set<number>();
const IN_FLIGHT_TTL_MS = 60_000;

function shortName(name: string): string {
  return name.replace(/^BRA\s*-\s*/i, "");
}

function hhmm(): string {
  const { hours, minutes } = vnHoursMinutes();
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

interface ViaConfig {
  viaCustomerId: string;
  viaName: string;
}

/** Create the pinned via-leg (via PSC → dropoff), already assigned to the driver. */
async function createViaLeg(
  driverId: string,
  viaCustomerId: string,
  viaName: string,
  originName: string,
  dropoffCustomerId: string,
  dropoffName: string,
  env: Env
): Promise<number> {
  const payload = {
    job_type_id: 1,
    schedule_type_id: 1,
    reference_number: `${shortName(viaName)}→${shortName(dropoffName)}_${hhmm()}`,
    labels: [PSC_VIA_LABEL],
    delivery_driver_id: driverId, // assign at creation — single call (pinned to the outbound's driver)
    stops: [
      {
        stop_type_id: 1,
        customer_id: viaCustomerId,
        duration: 5,
        todos: [
          { todo_type_id: 2, description: "📦 Chụp thấy rõ mẫu đã đóng gói trong hộp" },
          { todo_type_id: 2, description: "✍️ Chụp batchsheet đã ký" },
          { todo_type_id: 2, description: `🔻 Giao vật tư/tài liệu cho ${shortName(viaName)} (lấy từ ${shortName(originName)})` },
        ],
      },
      {
        stop_type_id: 2,
        customer_id: dropoffCustomerId,
        duration: 10,
        todos: [
          { todo_type_id: 2, description: "📋 Chụp các hộp thấy rõ batchsheet" },
          { todo_type_id: 2, description: "🤝 Chụp phiếu bàn giao & hàng mang về" },
        ],
      },
    ],
    items: [
      {
        description: "🧪 Mẫu",
        weight: 0,
        item_type_id: 1,
        quantity: 1,
        tracking_number: "",
        todos: [
          { todo_type_id: 3, stop_type_id: 1, is_required: true, description: "🔍 Quét mọi batchsheet" },
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
    throw new Error(`createViaLeg failed: ${res.status} ${JSON.stringify(err)}`);
  }

  const json = await res.json();
  const jobId = json.data?.job_id;
  if (!jobId) throw new Error("createViaLeg: no job_id in response");
  if (json.data?.delivery_driver_id !== driverId) {
    throw new Error(`createViaLeg: job ${jobId} created but not assigned to ${driverId}`);
  }
  return jobId as number;
}

/**
 * For configured via-routes (origin pickup → dropoff with a via PSC), create a pinned
 * via-leg (via → dropoff) for the same driver once that driver completes the origin pickup.
 * The driver is read off the engine-assigned outbound — we can't know it earlier because the
 * outbound is smart-assigned asynchronously.
 *
 * Trigger: outbound is still status 4 (assigned, not yet completed) and its origin pickup stop
 * is completed (status 4) — the driver is en route toward the via PSC. Already-completed (status
 * 5) outbounds are ignored: the driver has passed the via stop.
 */
export async function detectAndCreateViaLegs(
  env: Env,
  log: (msg: string, level?: LogLevel) => void
): Promise<void> {
  const routes = await loadPscRoutes();

  // Map "originPickupId:dropoffId" → via config, for rows that declare a via PSC.
  const viaConfig = new Map<string, ViaConfig>();
  for (const r of routes) {
    if (r.via_pickup && r.pickup && r.dropoff) {
      viaConfig.set(`${r.pickup}:${r.dropoff}`, {
        viaCustomerId: r.via_pickup,
        viaName: r.via_pickup_name || r.via_pickup,
      });
    }
  }
  if (viaConfig.size === 0) return; // nothing configured — no-op

  const today = vnDate();
  const [s4, s5] = await Promise.all([
    getJobsByStatusAndDate(4, today, env),
    getJobsByStatusAndDate(5, today, env),
  ]);

  // Index existing via-legs (status 4 + 5) by "via:dropoff:driver" → sorted create_ts strings.
  // Used to skip an outbound whose run already produced a via-leg after its pickup completed.
  const existingViaIndex = new Map<string, string[]>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const job of [...s4, ...s5] as any[]) {
    if (!(job.labels ?? []).includes(PSC_VIA_LABEL)) continue;
    if (!job.delivery_driver_id) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vp = (job.stops ?? []).find((s: any) => s.stop_type_id === 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vd = (job.stops ?? []).find((s: any) => s.stop_type_id === 2);
    if (!vp?.customer_id || !vd?.customer_id) continue;
    const key = `${vp.customer_id}:${vd.customer_id}:${job.delivery_driver_id}`;
    const arr = existingViaIndex.get(key) ?? [];
    arr.push(job.create_ts as string);
    existingViaIndex.set(key, arr);
  }

  // Outbound candidates: status-4 PSC outbounds matching a via-route, pickup completed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const outbound of s4 as any[]) {
    if (!(outbound.labels ?? []).includes(PSC_OUTBOUND_LABEL)) continue;
    if (!outbound.delivery_driver_id) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickupStop = (outbound.stops ?? []).find((s: any) => s.stop_type_id === 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dropoffStop = (outbound.stops ?? []).find((s: any) => s.stop_type_id === 2);
    if (!pickupStop?.customer_id || !dropoffStop?.customer_id) continue;

    const cfg = viaConfig.get(`${pickupStop.customer_id}:${dropoffStop.customer_id}`);
    if (!cfg) continue;

    // Fire only once the driver has completed the origin pickup (en route to the via PSC).
    if (pickupStop.stop_status_id !== 4) continue;
    const pickupDoneAt: string = (pickupStop.activity_completed_ts ?? "").slice(0, 19);
    if (!pickupDoneAt) continue;

    const driverId: string = outbound.delivery_driver_id;
    const viaKey = `${cfg.viaCustomerId}:${dropoffStop.customer_id}:${driverId}`;

    // Skip if a via-leg for this driver/route was already created after this pickup completed.
    const priorVia = existingViaIndex.get(viaKey) ?? [];
    if (priorVia.some((ts) => ts.slice(0, 19) > pickupDoneAt)) continue;
    if (inFlightVia.has(outbound.job_id)) continue;

    inFlightVia.add(outbound.job_id);
    setTimeout(() => inFlightVia.delete(outbound.job_id), IN_FLIGHT_TTL_MS);
    // Protect this key within the same cycle (e.g. two outbounds → same via:dropoff:driver).
    existingViaIndex.set(viaKey, [...priorVia, vnTimestamp()]);

    const originName: string = pickupStop.customer_name ?? pickupStop.name ?? pickupStop.customer_id;
    const dropoffName: string = dropoffStop.customer_name ?? dropoffStop.name ?? dropoffStop.customer_id;

    try {
      const newJobId = await createViaLeg(
        driverId,
        cfg.viaCustomerId,
        cfg.viaName,
        originName,
        dropoffStop.customer_id,
        dropoffName,
        env
      );
      log(`Via-leg ${shortName(cfg.viaName)}→${shortName(dropoffName)} #${newJobId} → driver (from outbound ${outbound.job_id})`, "OK");
    } catch (e) {
      log(`Via-leg failed for outbound ${outbound.job_id}: ${e}`, "ERROR");
      inFlightVia.delete(outbound.job_id);
      existingViaIndex.set(viaKey, priorVia); // allow retry next cycle
    }
  }
}
