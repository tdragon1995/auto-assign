/**
 * Kết quả / Vật tư from a PSC to a client, in two halves (supervisor, 2026-10-18):
 *
 *   1. COLLECT — a ONE-STOP job at the PSC, one per (PSC, client), carrying a photo
 *      to-do per booking. A later booking for the same client is APPENDED to it while
 *      the driver has not set off (stop still "Chờ lấy"); after that a new one is made.
 *      Given at booking to the client's driver: the fixed one, or for a smart client
 *      the on-duty candidate nearest the PSC.
 *   2. HAND OVER — once that stop is done the driver HOLDS the items. The next sample
 *      pickup at the client that is theirs and not yet started gets a photo to-do
 *      "Giao KQ/VT …". For a smart client the engine puts that pickup on the holder
 *      first (rankWithHolderFirst); a fixed client's driver is the holder anyway.
 *
 * Waiting longer than WAIT_ALERT_MS — not collected, or collected with no visit to
 * hang the hand-over on — puts a KQVT_WAITING row in "Cần xử lý".
 *
 * State is one small Redis hash, keyed by the collect job. The engine reads it once a
 * cycle and does nothing else when it is empty.
 *
 * Adding a to-do to a live job: the REST stop PUT REPLACES a stop's to-do list, so the
 * existing ones are echoed back with their stop_todo_id (kept untouched) plus the new
 * one — verified on throwaway prod jobs 2026-10-18. Only a stop still "Chờ lấy" is ever
 * touched, so no photo a driver already took is at stake.
 */
import { getJobDetails, getLiveDrivers, updateJobStops, type Env } from "./cartrack";
import { sharedRedis } from "./redis";
import { haversineKm } from "./distance";
import { resolveDriverChoices, resolveFixedDriver } from "./fixed-driver";
import { PSC_DELIVERY_LABEL } from "./job-filters";
import { vnTimestamp } from "./time";
import type { Config, FailedJob, Job, LogLevel } from "./types";
import type { LeaveEntry } from "./leave-config";

const KEY = "kqvt:pending";
export const WAIT_ALERT_MS = 24 * 3600_000;
const PHOTO = 2;

export interface KqvtItem { text: string; note: string; links: string[] }
export interface KqvtEntry {
  job_id: number;
  psc: string; psc_name: string;
  client_id: string; client_name: string;
  items: KqvtItem[];
  created_ms: number;
  /** Who the collect job was given at booking — names the holder when it is them. */
  collector?: string; collector_name?: string;
  holder?: string; holder_name?: string; collected_ms?: number;
}

function redis() {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? sharedRedis() : null;
}

export async function loadPending(): Promise<KqvtEntry[]> {
  const r = redis();
  if (!r) return [];
  const all = (await r.hgetall<Record<string, unknown>>(KEY)) ?? {};
  return Object.values(all).map((v) => (typeof v === "string" ? JSON.parse(v) : v) as KqvtEntry);
}
export async function savePending(e: KqvtEntry): Promise<void> {
  await redis()?.hset(KEY, { [String(e.job_id)]: JSON.stringify(e) });
}
export async function dropPending(jobId: number): Promise<void> {
  await redis()?.hdel(KEY, String(jobId));
}

/** The collect to-do / hand-over to-do text for one booking. */
export const collectTodo = (item: KqvtItem, client: string) =>
  `${item.text} cho ${client}${item.note ? ` — ${item.note}` : ""}`.slice(0, 250);
export const handoverTodo = (e: KqvtEntry) =>
  `Giao ${e.items.map((i) => i.text).join(" + ")} (từ ${e.psc_name})`.slice(0, 250);

/**
 * Who collects: the client's fixed driver, else — smart client — the candidate on duty
 * now whose live position is nearest the PSC (straight line: one call, no road
 * lookups; the hand-over then follows whoever it was). Null = leave it to the dispatcher.
 */
export async function pickCollector(
  config: Config, leave: LeaveEntry[], clientId: string, psc: { lat: number | null; lon: number | null }, env: Env,
): Promise<{ driverId: string; name: string | null } | null> {
  const fixed = resolveFixedDriver(config, clientId, new Date(), leave, null, { previewOnly: true });
  if (fixed) return { driverId: fixed.driverId, name: fixed.name };
  const choices = resolveDriverChoices(config, clientId, "", leave);
  if (!choices.ok || psc.lat == null || psc.lon == null) return null;
  const live = await getLiveDrivers(env).catch(() => null);
  if (!live) return null;
  const best = nearest(choices.drivers.map((d) => d.driverId), live, psc.lat, psc.lon);
  if (!best) return null;
  return { driverId: best.deliveryDriverId, name: `${best.firstName ?? ""} ${best.lastName ?? ""}`.trim() || null };
}

/** Logged-in, not on break, with a position; nearest to (lat, lon). */
export function nearest<T extends { deliveryDriverId: string; latitude?: number | null; longitude?: number | null; isLoggedIn?: boolean | null; onBreakSinceTs?: string | null }>(
  ids: string[], live: T[], lat: number, lon: number,
): T | null {
  let best: T | null = null, bestKm = Infinity;
  for (const d of live) {
    if (!ids.includes(d.deliveryDriverId) || !d.isLoggedIn || d.onBreakSinceTs || d.latitude == null || d.longitude == null) continue;
    const km = haversineKm(lat, lon, d.latitude, d.longitude);
    if (km < bestKm) { best = d; bestKm = km; }
  }
  return best;
}

/**
 * Add photo to-dos to one stop of a live job, keeping every existing to-do. Refuses
 * (returns why) unless that stop is still "Chờ lấy". Read back: the API answers 200
 * on writes it discards.
 */
export async function appendStopTodos(
  jobId: number, customerId: string, descriptions: string[], env: Env, noteLine?: string,
): Promise<"ok" | "started" | "missing" | "failed"> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const job: any = (await getJobDetails(jobId, env))?.data;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stops: any[] = job?.stops ?? [];
  const target = stops.find((s) => s.customer_id === customerId);
  if (!target || job.job_status_id === 7) return "missing";
  if (Number(target.stop_status_id) !== 1) return "started";
  const before = (target.todos ?? []).length;
  const res = await updateJobStops(jobId, stops.map((s) => s === target
    ? {
        stop_id: s.stop_id, stop_type_id: s.stop_type_id, customer_id: s.customer_id,
        ...(noteLine ? { note: [s.note, noteLine].filter(Boolean).join("\n") } : {}),
        todos: [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...(s.todos ?? []).map((t: any) => ({ stop_todo_id: t.stop_todo_id, todo_type_id: t.todo_type_id, description: t.description, is_required: t.is_required !== false })),
          ...descriptions.map((description) => ({ todo_type_id: PHOTO, description, is_required: true })),
        ],
      }
    : { stop_id: s.stop_id, stop_type_id: s.stop_type_id, customer_id: s.customer_id }), env, job.job_type_id);
  if (!res.ok) return "failed";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const after = (await getJobDetails(jobId, env))?.data?.stops?.find((s: any) => s.stop_id === target.stop_id);
  return (after?.todos ?? []).length === before + descriptions.length ? "ok" : "failed";
}

/** The holder's not-started sample pickup at the client, if today's lists have one. */
export function handoverTarget(e: KqvtEntry, jobs: Job[]): Job | null {
  return jobs.find((j) =>
    j.delivery_driver_id === e.holder &&
    j.job_status_id !== 7 &&
    !(j.labels ?? []).includes(PSC_DELIVERY_LABEL) &&
    (j.stops ?? []).some((s) => s.stop_type_id === 1 && s.customer_id === e.client_id && s.stop_status_id === 1),
  ) ?? null;
}

export function waitingTooLong(e: KqvtEntry, now: number): boolean {
  return now - (e.collected_ms ?? e.created_ms) > WAIT_ALERT_MS;
}

/** Smart ranking with the driver holding this client's items moved to the front;
 *  the rest keep their order, so an unavailable holder still falls through. */
export function rankWithHolderFirst<T>(ranked: T[], holder: string | undefined, idOf: (x: T) => string): T[] {
  const i = holder ? ranked.findIndex((x) => idOf(x) === holder) : -1;
  return i <= 0 ? ranked : [ranked[i], ...ranked.slice(0, i), ...ranked.slice(i + 1)];
}

export interface KqvtCycle {
  /** client_id → driver holding that client's items. */
  holders: Map<string, string>;
  /** Call after the engine assigns `job` to `driverId`: hangs the hand-over on it when
   *  that driver is the holder for its client. */
  afterAssign: (job: Job, driverId: string) => Promise<void>;
}

/**
 * Once a cycle, from the lists the cycle already fetched: note who collected, hang
 * hand-overs on the holders' pickups, raise the 24h rows. One Redis read when there
 * is nothing pending, nothing else.
 */
export async function kqvtCycle(
  jobsToday: Job[], env: Env, log: (msg: string, level?: LogLevel) => void, failed: FailedJob[],
): Promise<KqvtCycle> {
  const entries = await loadPending();
  const holders = new Map<string, string>();
  const byClient = new Map<string, KqvtEntry[]>();
  if (entries.length === 0) return { holders, afterAssign: async () => {} };

  const byId = new Map(jobsToday.map((j) => [j.job_id, j]));
  const now = Date.now();

  const attach = async (e: KqvtEntry, job: Job) => {
    const r = await appendStopTodos(job.job_id, e.client_id, [handoverTodo(e)], env);
    if (r === "ok") {
      await dropPending(e.job_id);
      log(`Job ${job.job_id} - KQ/VT giao kèm (${e.items.map((i) => i.text).join(" + ")}) | ${e.psc_name} → ${e.client_name}`, "OK");
      return true;
    }
    if (r === "failed") log(`Job ${job.job_id} - KQ/VT: không thêm được to-do giao | ${e.psc_name} → ${e.client_name}`, "WARN");
    return false;
  };

  for (const e of entries) {
    if (!e.holder) {
      const collect = byId.get(e.job_id);
      if (collect?.job_status_id === 7) { await dropPending(e.job_id); continue; }
      const stop = collect?.stops?.[0];
      if (collect?.delivery_driver_id && stop?.stop_status_id === 4) {
        e.holder = collect.delivery_driver_id;
        e.holder_name = e.holder === e.collector ? e.collector_name : collect.driver?.last_name ?? undefined;
        e.collected_ms = now;
        await savePending(e);
      }
    }
    if (e.holder) {
      const target = handoverTarget(e, jobsToday);
      if (target && await attach(e, target)) continue;
      holders.set(e.client_id, e.holder);
      byClient.set(e.client_id, [...(byClient.get(e.client_id) ?? []), e]);
    }
    if (waitingTooLong(e, now)) {
      failed.push({
        job_id: e.job_id,
        customer: `${e.psc_name} → ${e.client_name}`,
        reason: "KQVT_WAITING",
        detail: e.holder
          ? `${e.holder_name ?? "Tài xế"} đang giữ ${e.items.map((i) => i.text).join(" + ")}, chưa có chuyến lấy mẫu tại khách để giao kèm`
          : `${e.items.map((i) => i.text).join(" + ")} chưa được lấy tại ${e.psc_name}`,
        level: "WARN",
        ts: vnTimestamp(),
      });
    }
  }

  return {
    holders,
    afterAssign: async (job, driverId) => {
      const client = job.stops?.find((s) => s.stop_type_id === 1)?.customer_id;
      const waiting = (client && byClient.get(client)) || [];
      for (const e of [...waiting]) {
        // Taken off the list once hung, so a second pickup at the client this cycle
        // does not get the same hand-over again.
        if (e.holder === driverId && await attach(e, job).catch(() => false)) waiting.splice(waiting.indexOf(e), 1);
      }
    },
  };
}
