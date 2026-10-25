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
 * MULTI-LEG (supervisor, 2026-10-25): a client whose default drop-off is not the
 * booking PSC is reached by tracing back from that drop-off along the PSC routes
 * (D014 → D007 → D001). When the booking PSC is on that chain the items RIDE THE
 * RETURN TRIPS down it, one hop at a time — never one whose driver is due off within
 * 30 min, the ride home the cleanup cancels. The collect job is made at the drop-off
 * at booking, unassigned, and given to the client's driver only once the items
 * arrive. Anything else that is not the plain case — a booking PSC off the chain, a
 * client dropping at D001 — gets its collect job unassigned, for the dispatcher.
 *
 * Adding a to-do to a live job: the REST stop PUT REPLACES a stop's to-do list, so the
 * existing ones are echoed back with their stop_todo_id (kept untouched) plus the new
 * one — verified on throwaway prod jobs 2026-10-18. Only a stop still "Chờ lấy" is ever
 * touched, so no photo a driver already took is at stake.
 */
import { assignJob, BASE_URL, getHeaders, getJobDetails, getLiveDrivers, updateJobStops, type Env } from "./cartrack";
import { sharedRedis } from "./redis";
import { haversineKm } from "./distance";
import { resolveDriverChoices, resolveFixedDriver } from "./fixed-driver";
import { LAB_CUSTOMER_ID, PSC_DELIVERY_LABEL, PSC_RETURN_LABEL } from "./job-filters";
import { PSC_ROUTES } from "./psc-routes-data";
import { shortCode } from "./psc-dup";
import { returnRideable, shiftMappingsForPsc, subToCoveredDriver } from "./return-trips";
import { sbSelect } from "./supabase-rest";
import { vnTimestamp } from "./time";
import type { Config, FailedJob, Job, LogLevel } from "./types";
import type { LeaveEntry } from "./leave-config";

const KEY = "kqvt:pending";
export const WAIT_ALERT_MS = 24 * 3600_000;
/** How often a collect job missing from today's lists is looked up on its own. */
const RECHECK_MS = 30 * 60_000;
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
  /** Last direct lookup of the collect job (see kqvtCycle). */
  checked_ms?: number;
  /** Multi-leg only: the booking PSC, where the items are now, the PSCs still to reach
   *  (next first, last = psc), and the return trip carrying them. */
  origin?: string; at?: string; hops?: string[]; leg_job?: number; leg_checked_ms?: number;
}

export const pscName = (id: string) => {
  const r = PSC_ROUTES.find((x) => x.pickup === id);
  return r ? shortCode(r.psc_pickup) : id.slice(0, 8);
};

/** A PSC and the PSCs its samples travel through: D014 → [D014, D007, D001]. */
export function chainFrom(psc: string): string[] {
  const chain = [psc];
  for (;;) {
    const r = PSC_ROUTES.find((x) => x.pickup === chain[chain.length - 1]);
    if (!r || chain.includes(r.dropoff)) return chain;
    chain.push(r.dropoff);
  }
}

/** Where the collect job goes, the return-trip hops to get there, and whether it is
 *  given to the client's driver at booking. See the header. */
export function planDelivery(booking: string, dropoff: string | null): { collectAt: string; hops: string[]; autoAssign: boolean } {
  if (!dropoff) return { collectAt: booking, hops: [], autoAssign: true };
  if (dropoff === booking) return { collectAt: booking, hops: [], autoAssign: dropoff !== LAB_CUSTOMER_ID };
  const chain = chainFrom(dropoff);
  const k = chain.indexOf(booking);
  if (k > 0) return { collectAt: dropoff, hops: chain.slice(0, k).reverse(), autoAssign: false };
  return { collectAt: booking, hops: [], autoAssign: false };
}

/** The client's default drop-off from the master client list; null when unknown. */
export async function defaultDropoff(clientId: string): Promise<string | null> {
  const rows = await sbSelect<{ default_dropoff_id: string | null }>(
    "master_clients_read", `select=default_dropoff_id&customer_id=eq.${clientId}&limit=1`,
  ).catch(() => []);
  return rows[0]?.default_dropoff_id ?? null;
}

/** The two to-dos a return trip carries for one item: take it at `at`, leave it at the hop. */
export function legTodos(e: KqvtEntry): { pickup: string; dropoff: string } {
  const [hop, next] = e.hops ?? [];
  const what = `${itemsText(e.items)} cho ${e.client_name}`;
  return {
    pickup: `Nhận ${what} → mang về ${pscName(hop)}`.slice(0, 250),
    dropoff: `Gửi lại ${what} tại ${pscName(hop)}${next ? ` (chuyển tiếp ${pscName(next)})` : ""}`.slice(0, 250),
  };
}

/** A not-started, assigned return trip from where the items are to their next hop. */
export function rideFor(e: KqvtEntry, jobs: Job[], ok: (j: Job) => boolean): Job | null {
  const hop = e.hops?.[0];
  return jobs.find((j) =>
    j.job_status_id !== 7 && !!j.delivery_driver_id && (j.labels ?? []).includes(PSC_RETURN_LABEL) &&
    (j.stops ?? []).some((s) => s.stop_type_id === 1 && s.customer_id === e.at && s.stop_status_id === 1) &&
    (j.stops ?? []).some((s) => s.stop_type_id === 2 && s.customer_id === hop) && ok(j),
  ) ?? null;
}

/** The carrying return trip: drop-off at the hop done → arrived; cancelled/deleted → lost. */
export function legVerdict(job: CollectState | "gone" | null | undefined, hop: string): "arrived" | "lost" | "wait" {
  if (job === "gone" || job?.job_status_id === 7) return "lost";
  if (job?.stops?.some((s) => s.stop_type_id === 2 && s.customer_id === hop && s.stop_status_id === 4)) return "arrived";
  return "wait";
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
  `Giao ${itemsText(e.items)} (từ ${e.psc_name})`.slice(0, 250);

/** "📄 Kết quả ×2 + 📦 Vật tư" — repeats counted, first-seen order kept. */
export function itemsText(items: KqvtItem[]): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.text, (counts.get(i.text) ?? 0) + 1);
  return [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(" + ");
}

type CollectState = Pick<Job, "job_status_id" | "delivery_driver_id" | "stops">;

/** What the collect job's state means for its waiting item: gone/cancelled → drop it,
 *  stop done by a driver → collected, anything else (including "could not tell") → wait. */
export function collectVerdict(job: CollectState | "gone" | null | undefined): "drop" | "collected" | "wait" {
  if (job === "gone" || job?.job_status_id === 7) return "drop";
  if (job?.delivery_driver_id && job.stops?.[0]?.stop_status_id === 4) return "collected";
  return "wait";
}

/** One job read directly: "gone" only on a 404 (deleted), null when it could not tell. */
async function lookupJob(jobId: number, env: Env): Promise<CollectState | "gone" | null> {
  const res = await fetch(`${BASE_URL}/jobs/${jobId}`, { headers: getHeaders(env), cache: "no-store" }).catch(() => null);
  if (!res) return null;
  if (res.status === 404) return "gone";
  if (!res.ok) return null;
  return ((await res.json().catch(() => null))?.data as CollectState) ?? null;
}

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
 * Add photo to-dos to stops of a live job (customer → descriptions), keeping every
 * existing to-do; `noteLine` goes on the first. Refuses (returns why) unless every
 * stop touched is still "Chờ lấy". Read back: the API answers 200 on writes it discards.
 */
export async function appendStopTodos(
  jobId: number, adds: Record<string, string[]>, env: Env, noteLine?: string,
): Promise<"ok" | "started" | "missing" | "failed"> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const job: any = (await getJobDetails(jobId, env))?.data;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stops: any[] = job?.stops ?? [];
  const ids = Object.keys(adds);
  const targets = ids.map((id) => stops.find((s) => s.customer_id === id));
  if (job?.job_status_id === 7 || targets.some((t) => !t)) return "missing";
  if (targets.some((t) => Number(t.stop_status_id) !== 1)) return "started";
  const res = await updateJobStops(jobId, stops.map((s) => {
    const i = targets.indexOf(s);
    if (i < 0) return { stop_id: s.stop_id, stop_type_id: s.stop_type_id, customer_id: s.customer_id };
    return {
      stop_id: s.stop_id, stop_type_id: s.stop_type_id, customer_id: s.customer_id,
      ...(noteLine && i === 0 ? { note: [s.note, noteLine].filter(Boolean).join("\n") } : {}),
      todos: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(s.todos ?? []).map((t: any) => ({ stop_todo_id: t.stop_todo_id, todo_type_id: t.todo_type_id, description: t.description, is_required: t.is_required !== false })),
        ...adds[ids[i]].map((description) => ({ todo_type_id: PHOTO, description, is_required: true })),
      ],
    };
  }), env, job.job_type_id);
  if (!res.ok) return "failed";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const after: any[] = (await getJobDetails(jobId, env))?.data?.stops ?? [];
  return targets.every((t, i) =>
    (after.find((s) => s.stop_id === t.stop_id)?.todos ?? []).length === (t.todos ?? []).length + adds[ids[i]].length,
  ) ? "ok" : "failed";
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
  config: Config, leave: LeaveEntry[],
): Promise<KqvtCycle> {
  const entries = await loadPending();
  const holders = new Map<string, string>();
  const byClient = new Map<string, KqvtEntry[]>();
  if (entries.length === 0) return { holders, afterAssign: async () => {} };

  const byId = new Map(jobsToday.map((j) => [j.job_id, j]));
  const now = Date.now();
  let subCovers: Map<string, string> | null = null;
  const rideable = (j: Job, hop: string) =>
    returnRideable(shiftMappingsForPsc(config, hop, j.delivery_driver_id!, subCovers ??= subToCoveredDriver(config, leave)), new Date(now));

  /** One hop of a multi-leg item: follow the return carrying it, or load it on one. */
  const travel = async (e: KqvtEntry) => {
    const hop = e.hops![0];
    if (e.leg_job) {
      let leg: CollectState | "gone" | null | undefined = byId.get(e.leg_job);
      if (!leg && now - (e.leg_checked_ms ?? 0) > RECHECK_MS) {
        leg = await lookupJob(e.leg_job, env);
        e.leg_checked_ms = now;
        await savePending(e);
      }
      const v = legVerdict(leg, hop);
      if (v === "wait") return;
      log(`Job ${e.leg_job} - KQ/VT ${v === "arrived" ? `đã tới ${pscName(hop)}` : `chuyến về bị huỷ, chờ chuyến khác tại ${pscName(e.at!)}`} | ${e.psc_name} → ${e.client_name}`, v === "arrived" ? "OK" : "WARN");
      e.leg_job = undefined;
      if (v === "arrived") { e.at = hop; e.hops!.shift(); }
      if (!e.hops!.length) await arrive(e);
      await savePending(e);
      if (!e.hops?.length) return;
    }
    const ride = rideFor(e, jobsToday, (j) => rideable(j, e.hops![0]));
    if (!ride) return;
    const t = legTodos(e);
    const r = await appendStopTodos(ride.job_id, { [e.at!]: [t.pickup], [e.hops![0]]: [t.dropoff] }, env);
    if (r !== "ok") return;
    e.leg_job = ride.job_id;
    await savePending(e);
    log(`Job ${ride.job_id} - KQ/VT đi kèm chuyến về (${itemsText(e.items)}) | ${pscName(e.at!)} → ${pscName(e.hops![0])} → ${e.client_name}`, "OK");
  };

  /** At the client's drop-off: the waiting collect job goes to the client's driver. */
  const arrive = async (e: KqvtEntry) => {
    e.hops = undefined;
    const psc = PSC_ROUTES.find((r) => r.pickup === e.psc);
    const who = psc ? await pickCollector(config, leave, e.client_id, psc, env).catch(() => null) : null;
    const res = who ? await assignJob(who.driverId, e.job_id, env).catch(() => null) : null;
    const ok = !!res && res.status >= 200 && res.status < 300;
    if (ok) { e.collector = who!.driverId; e.collector_name = who!.name ?? undefined; }
    log(`Job ${e.job_id} - lấy KQ/VT tại PSC: ${ok ? who!.name ?? "tài xế" : "chờ điều phối"} | ${e.psc_name} → ${e.client_name}`, ok ? "OK" : "WARN");
  };

  const attach = async (e: KqvtEntry, job: Job) => {
    const r = await appendStopTodos(job.job_id, { [e.client_id]: [handoverTodo(e)] }, env);
    if (r === "ok") {
      await dropPending(e.job_id);
      log(`Job ${job.job_id} - KQ/VT giao kèm (${itemsText(e.items)}) | ${e.psc_name} → ${e.client_name}`, "OK");
      return true;
    }
    if (r === "failed") log(`Job ${job.job_id} - KQ/VT: không thêm được to-do giao | ${e.psc_name} → ${e.client_name}`, "WARN");
    return false;
  };

  for (const e of entries) {
    if (!e.holder) {
      // Today's lists miss a collect job dated another day, and every cancelled one —
      // so one missing from them is read on its own, at most every RECHECK_MS. Without
      // this a cancelled booking sat here until the 24h row (34497484, 2026-10-20).
      let collect: CollectState | "gone" | null | undefined = byId.get(e.job_id);
      if (!collect && now - (e.checked_ms ?? 0) > RECHECK_MS) {
        collect = await lookupJob(e.job_id, env);
        e.checked_ms = now;
        if (collectVerdict(collect) === "wait") await savePending(e);
      }
      const verdict = collectVerdict(collect);
      if (verdict === "drop") { await dropPending(e.job_id); continue; }
      if (verdict === "collected" && collect && collect !== "gone") {
        e.holder = collect.delivery_driver_id!;
        e.holder_name = e.holder === e.collector ? e.collector_name : (collect as Job).driver?.last_name ?? undefined;
        e.collected_ms = now;
        await savePending(e);
      }
      if (!e.holder && e.hops?.length) await travel(e);
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
          ? `${e.holder_name ?? "Tài xế"} đang giữ ${itemsText(e.items)}, chưa có chuyến lấy mẫu tại khách để giao kèm`
          : e.hops?.length
            ? e.leg_job
              ? `${itemsText(e.items)} đang trên chuyến về ${e.leg_job} tới ${pscName(e.hops[0])}`
              : `${itemsText(e.items)} đang ở ${pscName(e.at!)}, chưa có chuyến về ${pscName(e.hops[0])} để đi kèm`
            : `${itemsText(e.items)} chưa được lấy tại ${e.psc_name}`,
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
