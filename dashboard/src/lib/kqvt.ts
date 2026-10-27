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
 * 30 min, the ride home the cleanup cancels. No job exists until the items reach the
 * drop-off: only then is the collect job made there, given to the client's driver.
 * Until that the item is a list entry with a negative key (waitingKey). Anything else
 * that is not the plain case — a booking PSC off the chain, a client dropping at D001
 * (or with no drop-off, which means D001) — gets its collect job unassigned, for the
 * dispatcher.
 *
 * NEAR (supervisor, 2026-10-27): a client less than NEAR_KM by road from the booking
 * PSC gets one DIRECT 2-stop job instead — pick up at the PSC, deliver to the client —
 * given to the client's driver (D001 clients unassigned). It wins over multi-leg. Its
 * item is done when the delivery stop is.
 *
 * Adding a to-do to a live job: the REST stop PUT REPLACES a stop's to-do list, so the
 * existing ones are echoed back with their stop_todo_id (kept untouched) plus the new
 * one — verified on throwaway prod jobs 2026-10-18. Only a stop still "Chờ lấy" is ever
 * touched, so no photo a driver already took is at stake.
 */
import { BASE_URL, cancelJob, createJob, jobVnDate, getHeaders, getJobDetails, getLiveDrivers, updateJobStops, type Env } from "./cartrack";
import { sharedRedis } from "./redis";
import { haversineKm } from "./distance";
import { roadDistancesFromPoint } from "./distance-cache";
import { resolveDriverChoices, resolveFixedDriver } from "./fixed-driver";
import { LAB_CUSTOMER_ID, PSC_DELIVERY_LABEL, PSC_RETURN_LABEL } from "./job-filters";
import { PSC_ROUTES } from "./psc-routes-data";
import { shortCode } from "./psc-dup";
import { returnRideable, shiftMappingsForPsc, subToCoveredDriver } from "./return-trips";
import { sbSelect } from "./supabase-rest";
import { vnHoursMinutes, vnTimestamp } from "./time";
import type { Config, FailedJob, Job, LogLevel } from "./types";
import type { LeaveEntry } from "./leave-config";

const KEY = "kqvt:pending";
export const WAIT_ALERT_MS = 24 * 3600_000;
/** How often a collect job missing from today's lists is looked up on its own. */
const RECHECK_MS = 30 * 60_000;
const PHOTO = 2;

export interface KqvtItem {
  text: string; note: string; links: string[];
  /** Its row in the booking PSC's record (BookedRow): key suffix "<psc>:<day>" and row id. */
  log?: string; bid?: string;
}
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
  /** A direct PSC → client job (NEAR_KM): no collect/hand-over halves. */
  direct?: boolean;
}

export const NEAR_KM = 3;

/** Under NEAR_KM by road. The road lookup (cached, billed when new) is asked only when
 *  the straight line is already under — a road is never shorter. A failed lookup falls
 *  back to the straight line. */
export async function isNear(psc: { lat: number; lon: number }, client: { lat: number; lon: number } | null): Promise<boolean> {
  if (!client || haversineKm(psc.lat, psc.lon, client.lat, client.lon) >= NEAR_KM) return false;
  const [road] = await roadDistancesFromPoint(psc, [client]).catch(() => [null]);
  return road ? road.distance_km < NEAR_KM : true;
}

/** The direct job's state: cancelled/deleted → drop; delivery stop done → done. */
export function directVerdict(job: CollectState | "gone" | null | undefined): "drop" | "done" | "wait" {
  if (job === "gone" || job?.job_status_id === 7) return "drop";
  if (job?.job_status_id === 5 || job?.stops?.some((s) => s.stop_type_id === 2 && s.stop_status_id === 4)) return "done";
  return "wait";
}

/** The delivery to-do of one item on a direct job. */
export const deliverTodo = (item: KqvtItem) => `Giao ${item.text}${item.note ? ` — ${item.note}` : ""}`.slice(0, 250);

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
  // No default drop-off on the master list means D001 (supervisor, 2026-10-25).
  dropoff ??= LAB_CUSTOMER_ID;
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

/**
 * What a PSC booked, for its /qr page: one hash per booking PSC per day, a row per
 * item, kept 7 days. How it ENDED is a separate "<bid>:s" field, written once when the
 * item leaves the waiting list; everything before that is read off the list itself.
 */
export interface BookedRow { bid: string; ts: string; client: string; text: string; note: string; links?: string[] }
/** "toi" = a direct job delivered, by `who`. */
type Ending = { state: "giao" | "huy" | "xong" | "psc" | "toi"; job?: number; who?: string };
const BOOKED_TTL_S = 7 * 86400;

export async function logBooking(log: string, row: BookedRow): Promise<void> {
  const r = redis();
  if (!r) return;
  await r.hset(`kqvt:booked:${log}`, { [row.bid]: JSON.stringify(row) });
  await r.expire(`kqvt:booked:${log}`, BOOKED_TTL_S);
}

/** Record how an entry's items ended, on their booking rows. Never fails the caller. */
export async function closeItems(e: KqvtEntry, ending: Ending): Promise<void> {
  const r = redis();
  if (!r) return;
  for (const i of e.items) {
    if (!i.log || !i.bid) continue;
    await r.hset(`kqvt:booked:${i.log}`, { [`${i.bid}:s`]: JSON.stringify(ending) }).catch(() => {});
    await r.expire(`kqvt:booked:${i.log}`, BOOKED_TTL_S).catch(() => {});
  }
}

export interface BookedView extends BookedRow { status: string; tone: "wait" | "move" | "done" | "off"; job: number | null; cancellable: boolean }

export async function loadBooked(psc: string, day: string): Promise<BookedView[]> {
  const r = redis();
  if (!r) return [];
  const all = (await r.hgetall<Record<string, unknown>>(`kqvt:booked:${psc}:${day}`)) ?? {};
  const parse = <T,>(v: unknown) => (typeof v === "string" ? JSON.parse(v) : v) as T;
  const rows = Object.entries(all).filter(([k]) => !k.endsWith(":s")).map(([, v]) => parse<BookedRow>(v));
  const open = rows.some((x) => all[`${x.bid}:s`] == null) ? await loadPending() : [];
  return rows
    .map((x) => {
      const ending = all[`${x.bid}:s`] == null ? null : parse<Ending>(all[`${x.bid}:s`]);
      const e = ending ? undefined : open.find((y) => y.items.some((i) => i.bid === x.bid));
      return { ...x, ...bookedStatus(x.bid, ending, open), cancellable: !!e && !cancelBlock(e) };
    })
    .sort((a, b) => b.ts.localeCompare(a.ts));
}

/** Why the PSC may no longer call an item off — null while nobody has taken it. */
export function cancelBlock(e: KqvtEntry): string | null {
  if (e.holder || (e.direct && e.collected_ms)) return "Tài xế đã lấy — liên hệ điều phối để huỷ.";
  if (e.job_id < 0 && e.leg_job) return "Đang trên chuyến về — liên hệ điều phối để huỷ.";
  return null;
}

/**
 * The PSC calls one booking off. Still waiting for its first ride → it just leaves the
 * list. On a collect job not yet started: the job is cancelled when this was its only
 * item (as /qr's own "Huỷ"), else only this item's to-do comes off the stop.
 */
export async function cancelBooking(psc: string, day: string, bid: string, env: Env): Promise<{ ok: true; client: string; text: string } | { ok: false; status: number; error: string }> {
  const r = redis();
  if (!r) return { ok: false, status: 503, error: "Chưa huỷ được lúc này — báo điều phối." };
  const key = `kqvt:booked:${psc}:${day}`;
  const [row, ended] = await Promise.all([r.hget(key, bid), r.hget(key, `${bid}:s`)]);
  if (!row) return { ok: false, status: 404, error: "Không tìm thấy yêu cầu." };
  if (ended) return { ok: false, status: 409, error: "Yêu cầu đã kết thúc." };
  const e = (await loadPending()).find((x) => x.items.some((i) => i.bid === bid));
  if (!e) return { ok: false, status: 409, error: "Yêu cầu đang được tạo — thử lại sau ít phút." };
  const block = cancelBlock(e);
  if (block) return { ok: false, status: 409, error: block };
  const item = e.items.find((i) => i.bid === bid)!;
  const rest = e.items.filter((i) => i !== item);

  if (e.job_id > 0) {
    if (rest.length === 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const job: any = (await getJobDetails(e.job_id, env))?.data;
      if (job && Number(job.stops?.[0]?.stop_status_id) !== 1) return { ok: false, status: 409, error: "Tài xế đã bắt đầu đi lấy — liên hệ điều phối để huỷ." };
      if (job && job.job_status_id !== 3 && job.job_status_id !== 7 && !(await cancelJob(e.job_id, jobVnDate(job), env))) {
        return { ok: false, status: 502, error: "Huỷ thất bại, vui lòng thử lại." };
      }
    } else {
      let res = await removeStopTodo(e.job_id, e.psc, collectTodo(item, e.client_name), env);
      // A direct job carries the item twice: collected at the PSC, delivered at the client.
      if (res === "ok" && e.direct) res = await removeStopTodo(e.job_id, e.client_id, deliverTodo(item), env);
      if (res === "started") return { ok: false, status: 409, error: "Tài xế đã bắt đầu đi lấy — liên hệ điều phối để huỷ." };
      if (res !== "ok") return { ok: false, status: 502, error: "Huỷ thất bại, vui lòng thử lại." };
    }
  }
  if (rest.length) await savePending({ ...e, items: rest });
  else await dropPending(e.job_id);
  await closeItems({ ...e, items: [item] }, { state: "psc", ...(e.job_id > 0 ? { job: e.job_id } : {}) });
  return { ok: true, client: e.client_name, text: item.text };
}

/** Take one to-do (by its text) off a not-started stop, keeping the rest, and say so in
 *  the stop note. Same echo-and-read-back rules as appendStopTodos. */
async function removeStopTodo(jobId: number, customerId: string, description: string, env: Env): Promise<"ok" | "started" | "missing" | "failed"> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const job: any = (await getJobDetails(jobId, env))?.data;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stops: any[] = job?.stops ?? [];
  const target = stops.find((s) => s.customer_id === customerId);
  if (!target || job.job_status_id === 7) return "missing";
  if (Number(target.stop_status_id) !== 1) return "started";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const todos: any[] = target.todos ?? [];
  const drop = todos.findIndex((t) => t.description === description);
  if (drop < 0) return "missing";
  const keep = todos.filter((_, i) => i !== drop);
  const res = await updateJobStops(jobId, stops.map((s) => s === target
    ? {
        stop_id: s.stop_id, stop_type_id: s.stop_type_id, customer_id: s.customer_id,
        note: [s.note, `ĐÃ HUỶ: ${description}`].filter(Boolean).join("\n"),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        todos: keep.map((t: any) => ({ stop_todo_id: t.stop_todo_id, todo_type_id: t.todo_type_id, description: t.description, is_required: t.is_required !== false })),
      }
    : { stop_id: s.stop_id, stop_type_id: s.stop_type_id, customer_id: s.customer_id }), env, job.job_type_id);
  if (!res.ok) return "failed";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const after = (await getJobDetails(jobId, env))?.data?.stops?.find((s: any) => s.stop_id === target.stop_id);
  return (after?.todos ?? []).length === keep.length ? "ok" : "failed";
}

/** One booking's state in words for the PSC: its ending, else where it is on the list. */
export function bookedStatus(bid: string, ending: Ending | null, entries: KqvtEntry[]): Pick<BookedView, "status" | "tone" | "job"> {
  if (ending?.state === "giao") return { status: "Đã giao kèm chuyến lấy mẫu tại khách", tone: "done", job: ending.job ?? null };
  if (ending?.state === "huy") return { status: "Chuyến lấy đã bị huỷ", tone: "off", job: ending.job ?? null };
  if (ending?.state === "xong") return { status: "Điều phối đã xử lý", tone: "done", job: ending.job ?? null };
  if (ending?.state === "psc") return { status: "Đã huỷ", tone: "off", job: null };
  if (ending?.state === "toi") return { status: `Đã giao tận nơi${ending.who ? ` — ${ending.who}` : ""}`, tone: "done", job: ending.job ?? null };
  const e = entries.find((x) => x.items.some((i) => i.bid === bid));
  if (!e) return { status: "Đang cập nhật", tone: "wait", job: null };
  if (e.job_id < 0) {
    const hop = e.hops?.[0];
    if (e.leg_job && hop) return { status: `Đang trên chuyến về ${pscName(hop)}`, tone: "move", job: e.leg_job };
    if (hop) return { status: `Chờ chuyến về ${pscName(hop)} tại ${pscName(e.at!)}`, tone: "wait", job: null };
    return { status: `Đã tới ${e.psc_name}, đang tạo chuyến lấy`, tone: "move", job: null };
  }
  if (e.direct) {
    if (e.collected_ms) return { status: `${e.collector_name ?? "Tài xế"} đang giao tận nơi`, tone: "move", job: e.job_id };
    return { status: `Giao trực tiếp — ${e.collector ? `${e.collector_name ?? "tài xế"}, chưa lấy` : "chờ điều phối"}`, tone: "wait", job: e.job_id };
  }
  if (e.holder) return { status: `${e.holder_name ?? "Tài xế"} đã lấy, sẽ giao kèm chuyến lấy mẫu tại khách`, tone: "move", job: e.job_id };
  return { status: `Chờ ${e.collector_name ?? "điều phối"} lấy tại ${e.psc_name}`, tone: "wait", job: e.job_id };
}

/** The collect to-do / hand-over to-do text for one booking. */
export const collectTodo = (item: KqvtItem, client: string) =>
  `${item.text} cho ${client}${item.note ? ` — ${item.note}` : ""}`.slice(0, 250);
export const handoverTodo = (e: KqvtEntry) =>
  `Giao ${itemsText(e.items)} (từ ${e.psc_name})`.slice(0, 250);

/** The list key of a multi-leg item that has no collect job yet: negative, so it never
 *  meets a real job id. */
let seq = 0;
export const waitingKey = () => -(Date.now() * 100 + (seq++ % 100));

/**
 * The one-stop collect job at `e.psc`, a photo to-do per item, given to `who` — or to
 * nobody when Cartrack refuses that driver (4xx costs the driver, not the booking).
 * jobId 0 = not created.
 */
export async function createCollectJob(
  e: Pick<KqvtEntry, "psc" | "origin" | "client_name" | "items"> & { client_id?: string }, extraNote: string, who: { driverId: string } | null, env: Env,
  /** A DIRECT job: also a delivery stop at e.client_id (NEAR_KM). */
  direct = false,
): Promise<{ jobId: number; driverId: string | null; status: number; body: unknown }> {
  const { hours, minutes } = vnHoursMinutes();
  const links = e.items.flatMap((i) => i.links);
  const payload = {
    job_type_id: direct ? 1 : 3,
    schedule_type_id: 1,
    reference_number: `${pscName(e.origin ?? e.psc)}→${e.client_name.slice(0, 60)}_${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
    labels: [PSC_DELIVERY_LABEL],
    stops: [{
      stop_type_id: direct ? 1 : 3, customer_id: e.psc, duration: 5,
      note: [...e.items.map((i) => collectTodo(i, e.client_name)), extraNote, ...links.map((u, i) => `Ảnh ${i + 1}: ${u}`)].filter(Boolean).join("\n"),
      todos: e.items.map((i) => ({ todo_type_id: PHOTO, description: collectTodo(i, e.client_name), is_required: true })),
    }, ...(direct ? [{
      stop_type_id: 2, customer_id: e.client_id, duration: 5,
      todos: e.items.map((i) => ({ todo_type_id: PHOTO, description: deliverTodo(i), is_required: true })),
    }] : [])],
  };
  let res = await createJob(who ? { ...payload, delivery_driver_id: who.driverId } : payload, env);
  let driverId = who?.driverId ?? null;
  if (!res.ok && who && res.status >= 400 && res.status < 500) { res = await createJob(payload, env); driverId = null; }
  return { jobId: res.ok ? Number(res.body?.data?.job_id) || 0 : 0, driverId, status: res.status, body: res.body };
}

/** "📄 Kết quả ×2 + 📦 Vật tư" — repeats counted, first-seen order kept. */
export function itemsText(items: KqvtItem[]): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.text, (counts.get(i.text) ?? 0) + 1);
  return [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(" + ");
}

/** List rows from the route timeline carry the full name in first_name. */
const driverName = (j: Job) => `${j.driver?.first_name ?? ""} ${j.driver?.last_name ?? ""}`.trim() || undefined;

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

  /** A multi-leg item: follow the return carrying it, load it on one, or — arrived at
   *  the drop-off — make its collect job there. */
  const travel = async (e: KqvtEntry) => {
    if (e.leg_job && e.hops?.length) {
      const hop = e.hops[0];
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
      if (v === "arrived") { e.at = hop; e.hops.shift(); }
      await savePending(e);
    }
    if (!e.hops?.length) return arrive(e);
    const ride = rideFor(e, jobsToday, (j) => rideable(j, e.hops![0]));
    if (!ride) return;
    const t = legTodos(e);
    const r = await appendStopTodos(ride.job_id, { [e.at!]: [t.pickup], [e.hops[0]]: [t.dropoff] }, env);
    if (r !== "ok") return;
    e.leg_job = ride.job_id;
    await savePending(e);
    log(`Job ${ride.job_id} - KQ/VT đi kèm chuyến về (${itemsText(e.items)}) | ${pscName(e.at!)} → ${pscName(e.hops[0])} → ${e.client_name}`, "OK");
  };

  /** At the client's drop-off: only now is the collect job made, given to the client's
   *  driver. A failed create is retried next cycle — the item stays on the list. */
  const arrive = async (e: KqvtEntry) => {
    const psc = PSC_ROUTES.find((r) => r.pickup === e.psc);
    const who = psc ? await pickCollector(config, leave, e.client_id, psc, env).catch(() => null) : null;
    const res = await createCollectJob(e, `Chuyển từ ${pscName(e.origin!)} theo chuyến về`, who, env);
    if (!res.jobId) {
      log(`Giao KQ/VT FAILED - chưa tạo được chuyến lấy tại ${e.psc_name} (${res.status}) | ${pscName(e.origin!)} → ${e.client_name}`, "WARN");
      return;
    }
    const waitKey = e.job_id;
    Object.assign(e, { job_id: res.jobId, hops: undefined, collector: res.driverId ?? undefined, collector_name: res.driverId ? who?.name ?? undefined : undefined });
    await savePending(e);
    await dropPending(waitKey);
    log(`Job ${e.job_id} - lấy KQ/VT tại PSC: ${res.driverId ? who?.name ?? "tài xế" : "chờ điều phối"} | ${e.psc_name} → ${e.client_name}`, "OK");
  };

  const attach = async (e: KqvtEntry, job: Job) => {
    const r = await appendStopTodos(job.job_id, { [e.client_id]: [handoverTodo(e)] }, env);
    if (r === "ok") {
      await dropPending(e.job_id);
      await closeItems(e, { state: "giao", job: job.job_id });
      log(`Job ${job.job_id} - KQ/VT giao kèm (${itemsText(e.items)}) | ${e.psc_name} → ${e.client_name}`, "OK");
      return true;
    }
    if (r === "failed") log(`Job ${job.job_id} - KQ/VT: không thêm được to-do giao | ${e.psc_name} → ${e.client_name}`, "WARN");
    return false;
  };

  for (const e of entries) {
    // Still travelling: no collect job exists yet (job_id is the waiting key, < 0).
    if (e.job_id < 0) await travel(e);
    else if (!e.holder) {
      // Today's lists miss a collect job dated another day, and every cancelled one —
      // so one missing from them is read on its own, at most every RECHECK_MS. Without
      // this a cancelled booking sat here until the 24h row (34497484, 2026-10-20).
      let collect: CollectState | "gone" | null | undefined = byId.get(e.job_id);
      if (!collect && now - (e.checked_ms ?? 0) > RECHECK_MS) {
        collect = await lookupJob(e.job_id, env);
        e.checked_ms = now;
        if ((e.direct ? directVerdict(collect) : collectVerdict(collect)) === "wait") await savePending(e);
      }
      if (e.direct) {
        // Follow the job as Cartrack has it: whoever holds it now (the dispatcher may
        // have given or moved it), and whether the PSC stop is done.
        if (collect && collect !== "gone") {
          const id = collect.delivery_driver_id || undefined;
          const picked = collect.stops?.[0]?.stop_status_id === 4;
          if (id !== e.collector || picked !== !!e.collected_ms) {
            const name = driverName(collect as Job);
            e.collector_name = id === e.collector ? e.collector_name : id ? name : undefined;
            e.collector = id;
            e.collected_ms = picked ? e.collected_ms ?? now : undefined;
            await savePending(e);
          }
        }
        const v = directVerdict(collect);
        if (v !== "wait") {
          await dropPending(e.job_id);
          await closeItems(e, v === "done" ? { state: "toi", job: e.job_id, who: e.collector_name } : { state: "huy", job: e.job_id });
          continue;
        }
      }
      const verdict = e.direct ? "wait" : collectVerdict(collect);
      if (verdict === "drop") { await dropPending(e.job_id); await closeItems(e, { state: "huy", job: e.job_id }); continue; }
      if (verdict === "collected" && collect && collect !== "gone") {
        e.holder = collect.delivery_driver_id!;
        e.holder_name = e.holder === e.collector ? e.collector_name : driverName(collect as Job);
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
          ? `${e.holder_name ?? "Tài xế"} đang giữ ${itemsText(e.items)}, chưa có chuyến lấy mẫu tại khách để giao kèm`
          : e.job_id < 0
            ? e.leg_job
              ? `${itemsText(e.items)} đang trên chuyến về ${e.leg_job} tới ${pscName(e.hops![0])}`
              : e.hops?.length
                ? `${itemsText(e.items)} đang ở ${pscName(e.at!)}, chưa có chuyến về ${pscName(e.hops[0])} để đi kèm`
                : `${itemsText(e.items)} đã tới ${e.psc_name}, chưa tạo được chuyến lấy`
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
