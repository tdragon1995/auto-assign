import { Redis } from "@upstash/redis";
import { getTimelineJobs, getUnroutedJobs, type Env } from "./cartrack";
import { isBlockingPickupStop, pscPairKey, PSC_VIA_LABEL } from "./job-filters";
import { driverDisplayName } from "./job-detail";
import type { Job, Stop } from "./types";

/**
 * One fetch of the day, many projections.
 *
 * Before this, four consumers each pulled and parsed the SAME ~1.4 MB Cartrack day:
 * /api/location-jobs kept its own per-location cache, a driver-jobs-cache module kept its
 * own per-driver cache (now deleted — chấm-công reads the byDriver projection here), and
 * /api/smart-assign + /api/driver-jobs fetched uncached on every request. Those last two
 * are still uncached and still the remaining duplicate fetches of this same day.
 * Separately, the assign cycle wrote a blocked-pickup index that only it could
 * refresh — so a branch could be refused over a trip whose samples had already been
 * collected, because the index sat frozen between cycles while the branch's own feed
 * showed the truth. Two readers, two clocks, one contradiction on screen.
 *
 * Everything display-facing now reads this snapshot, so the feed and the duplicate
 * guard can no longer disagree about the same day.
 *
 * STORAGE SHAPE — each job stored ONCE, plus id-only indexes.
 * Measured on a real day (2026-07-31, 503 jobs / 77 drivers / 193 locations): bucketing
 * whole jobs under every location AND driver writes 1,305 KB per rebuild, because each
 * job lands in ~3 buckets. Storing each job once and pointing at it by id writes 467 KB
 * — 2.8x less — for the same read cost, since a reader still parses only its own jobs
 * and never the whole-network blob. The price is one extra round-trip: read the index,
 * then HMGET the ids it names.
 */

/** How stale a snapshot may be before a read rebuilds it.
 *
 *  This has to sit ABOVE the real gap between requests or the cache does nothing.
 *  Measured in production over 12h: 516 feed requests, i.e. one every ~84 seconds.
 *  At the original 30s it was stale on arrival almost every time — 682 JSON-RPC calls
 *  to Cartrack for 516 requests, roughly two rebuilds every three visits, each one
 *  re-fetching the whole network's day and rewriting ~467 KB to Redis. Two requests
 *  have to land inside one window for anything to be shared, and at 84s apart they
 *  never did.
 *
 *  Freshness is not what this protects. psc-assign re-checks the live job before it
 *  refuses anyone (`stillBlocking`), so a stale snapshot can no longer cause a wrong
 *  refusal — the D006 bug cannot come back through this number. Làm mới, cancels and
 *  3PL handoffs all pass fresh=1 and rebuild regardless. What is left is only how old
 *  the branch's screen may look when nobody has touched anything, and 90s of that is
 *  what the feed showed for months before any of this. */
export const MAX_AGE_MS = 90_000;

/** Hash lifetime. Long enough that a quiet stretch doesn't force a cold rebuild,
 *  short enough that a stale day self-clears. Freshness is decided by __built__,
 *  not by this. */
const HASH_TTL_S = 900;

/** Guards a rebuild so several readers crossing the freshness line in the same second
 *  don't all parse the day at once. The loser serves what's already cached. */
const LOCK_TTL_S = 20;

const BUILT = "__built__";
const IDX_LOC = "x:loc";
const IDX_DRV = "x:drv";
const IDX_PAIRS = "x:pairs";
const jobField = (id: number) => `j:${id}`;

function key(env: Env, date: string) { return `day:v1:${env}:${date}`; }
function lockKey(env: Env, date: string) { return `day:lock:${env}:${date}`; }

function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/** The slimmed job every consumer reads. Deliberately NOT carrying address_line_1 or
 *  todos: on a 786-job day the addresses alone were 111 KB, and neither is rendered in
 *  a list — they come from the per-job detail call, which has its own cache. `labels`
 *  IS kept: the duplicate guard has to exclude via-legs by label, and dropping it was
 *  what forced that guard onto a separate Cartrack fetch. */
export interface SnapJob {
  job_id: number;
  reference_number: string | null;
  job_status_id: number | undefined;
  scheduled_delivery_ts: string | null;
  /** Chấm-công's fallback timestamp for when a driver tapped check-in/out, used when the
   *  stop carries no activity_* time yet. Note the timeline has no real create_ts — it
   *  substitutes scheduledDeliveryTs — which is exact here, because a chấm-công job is
   *  created and scheduled in the same instant. */
  create_ts: string | null;
  last_assigned_plan_id: number | null;
  labels: string[];
  item_tracking_numbers: string[];
  delivery_driver_id: string | null;
  driver: { last_name: string | null };
  stops: SnapStop[];
  rejected_ts: string | null;
  rejected_reason: string | null;
}

export interface SnapStop {
  stop_id: number | undefined;
  stop_type_id: number | undefined;
  stop_status_id: number | undefined;
  customer_id: string | undefined;
  customer_name: string;
  activity_started_ts: string | null;
  activity_arrived_ts: string | null;
  activity_completed_ts: string | null;
  delivery_windows: { time_from: string | null; time_to: string | null }[];
}

export interface PairHit { job_id: number; reference_number: string | null }

function slimStop(s: Stop): SnapStop {
  return {
    stop_id: s.stop_id,
    stop_type_id: s.stop_type_id,
    stop_status_id: s.stop_status_id,
    customer_id: s.customer_id,
    customer_name: s.customer_name ?? s.name ?? "",
    activity_started_ts: s.activity_started_ts ?? null,
    activity_arrived_ts: s.activity_arrived_ts ?? null,
    activity_completed_ts: s.activity_completed_ts ?? null,
    delivery_windows: (s.delivery_windows ?? [])
      .map((w) => ({ time_from: w.time_from ?? null, time_to: w.time_to ?? null }))
      .filter((w) => w.time_from || w.time_to),
  };
}

/** Also used by the REST fallbacks, so a degraded response has the same shape as a
 *  cached one and the client never has to care which path served it. */
export function slimJob(j: Job, driverName: string | null): SnapJob {
  return {
    job_id: j.job_id,
    reference_number: j.reference_number ?? null,
    job_status_id: j.job_status_id,
    scheduled_delivery_ts: j.scheduled_delivery_ts ?? null,
    create_ts: j.create_ts ?? null,
    last_assigned_plan_id: j.last_assigned_plan_id ?? null,
    labels: (j.labels ?? []).filter((l): l is string => typeof l === "string"),
    item_tracking_numbers: j.item_tracking_numbers ?? [],
    delivery_driver_id: j.delivery_driver_id ?? null,
    driver: { last_name: driverName },
    stops: (j.stops ?? []).map(slimStop),
    rejected_ts: null,
    rejected_reason: null,
  };
}

/** Map a delivery_jobs_list_new row (camelCase, driverless by definition) into the same
 *  shape, so unassigned and rejected trips sit beside the routed ones. The timeline only
 *  ever carries statuses 4 and 5, so without this source a branch never sees a request
 *  that hasn't been picked up yet — nor, therefore, does the duplicate guard. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function slimUnrouted(j: any): SnapJob {
  const t19 = (s: unknown): string | null =>
    typeof s === "string" && s.length >= 19 ? s.slice(0, 19).replace("T", " ") : null;
  return {
    job_id: j.jobId,
    reference_number: j.referenceNumber ?? null,
    job_status_id: j.jobStatusId,
    scheduled_delivery_ts: t19(j.scheduledTs),
    create_ts: t19(j.createTs) ?? t19(j.scheduledTs),
    last_assigned_plan_id: null,
    labels: (j.jobLabels ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((l: any) => (typeof l === "string" ? l : l?.label))
      .filter((l: unknown): l is string => typeof l === "string"),
    item_tracking_numbers: [],
    delivery_driver_id: null,
    driver: { last_name: null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stops: (j.stops ?? []).map((s: any): SnapStop => ({
      stop_id: s.stopId,
      stop_type_id: s.stopTypeId,
      stop_status_id: s.stopStatusId,
      customer_id: s.customerId,
      customer_name: s.customerName ?? "",
      activity_started_ts: null,
      activity_arrived_ts: null,
      activity_completed_ts: null,
      delivery_windows: (s.deliveryWindows ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((w: any) => ({ time_from: w?.timeFrom ?? null, time_to: w?.timeTo ?? null }))
        .filter((w: { time_from: string | null }) => w.time_from),
    })),
    rejected_ts: t19(j.rejectedTs),
    rejected_reason: j.rejectedReason ?? null,
  };
}

/** pickup|dropoff pairs a new request would collide with. Mirrors what the assign cycle
 *  used to write on its own schedule — now rebuilt by whoever reads the day, so it can't
 *  sit frozen between cycles. */
function buildPairs(jobs: SnapJob[]): Record<string, PairHit> {
  const pairs: Record<string, PairHit> = {};
  for (const j of jobs) {
    if (j.job_status_id === 7 || j.job_status_id === 3) continue;
    if (j.labels.includes(PSC_VIA_LABEL)) continue;
    const pickups = j.stops.filter((s) => s.stop_type_id === 1 && s.customer_id && isBlockingPickupStop(s));
    if (!pickups.length) continue;
    const dropoffs = j.stops.filter((s) => s.stop_type_id === 2 && s.customer_id);
    const hit: PairHit = { job_id: j.job_id, reference_number: j.reference_number };
    for (const p of pickups) for (const d of dropoffs) {
      const k = pscPairKey(p.customer_id!, d.customer_id!);
      if (!(k in pairs)) pairs[k] = hit;
    }
  }
  return pairs;
}

export interface Snapshot {
  jobs: Map<number, SnapJob>;
  byLocation: Record<string, number[]>;
  byDriver: Record<string, number[]>;
  pairs: Record<string, PairHit>;
  builtAt: number;
}

/** Fetch + parse the whole day. Both sources are needed: the timeline carries statuses
 *  4/5, the unrouted pool 2/3. Returns null if the timeline is unavailable so callers
 *  keep their own REST fallback rather than serving an empty day as if it were real. */
export async function buildSnapshot(date: string, env: Env): Promise<Snapshot | null> {
  const [timeline, unrouted] = await Promise.all([
    getTimelineJobs(date, env).catch(() => null),
    getUnroutedJobs(date, env).catch(() => null),
  ]);
  if (!timeline) return null;

  const all: SnapJob[] = [
    // driverDisplayName, not a hand-rolled fallback: REST puts the human name in
    // last_name while a timeline-derived job carries it in first_name behind an internal
    // staff code ("F - C - DC100320 Lý Chánh Hùng"). Picking the wrong field renders a
    // blank name on the branch's card; picking it raw renders the code.
    ...timeline.map((j) => slimJob(j, driverDisplayName(j.driver))),
    ...(unrouted ?? []).filter((j) => j?.jobStatusId === 2 || j?.jobStatusId === 3).map(slimUnrouted),
  ];

  const jobs = new Map<number, SnapJob>();
  const byLocation: Record<string, number[]> = {};
  const byDriver: Record<string, number[]> = {};
  for (const j of all) {
    if (j.job_id == null) continue;
    jobs.set(j.job_id, j);
    // A job touching one location twice (pickup AND dropoff there) is listed once for it.
    const seen = new Set<string>();
    for (const s of j.stops) {
      if (!s.customer_id || seen.has(s.customer_id)) continue;
      seen.add(s.customer_id);
      (byLocation[s.customer_id] ??= []).push(j.job_id);
    }
    if (j.delivery_driver_id) (byDriver[j.delivery_driver_id] ??= []).push(j.job_id);
  }

  return { jobs, byLocation, byDriver, pairs: buildPairs(all), builtAt: Date.now() };
}

async function write(redis: Redis, env: Env, date: string, snap: Snapshot): Promise<void> {
  const fields: Record<string, string> = {
    [BUILT]: String(snap.builtAt),
    [IDX_LOC]: JSON.stringify(snap.byLocation),
    [IDX_DRV]: JSON.stringify(snap.byDriver),
    [IDX_PAIRS]: JSON.stringify(snap.pairs),
  };
  for (const [id, j] of snap.jobs) fields[jobField(id)] = JSON.stringify(j);
  // DEL first so yesterday's jobs for a location that has none today don't linger, and
  // as a transaction so a concurrent reader never sees a half-built hash.
  const tx = redis.multi();
  tx.del(key(env, date));
  tx.hset(key(env, date), fields);
  tx.expire(key(env, date), HASH_TTL_S);
  await tx.exec();
}

function parse<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === "string") { try { return JSON.parse(raw) as T; } catch { return fallback; } }
  return raw as T;
}

/** Rebuild + store, guarded so concurrent readers don't all parse the day. Returns the
 *  snapshot when this caller did the work, null when someone else holds the lock (the
 *  caller then serves whatever is cached). */
async function rebuild(redis: Redis | null, date: string, env: Env): Promise<Snapshot | null> {
  if (redis) {
    const got = await redis.set(lockKey(env, date), Date.now(), { nx: true, ex: LOCK_TTL_S });
    if (got !== "OK") return null;
  }
  try {
    const snap = await buildSnapshot(date, env);
    if (snap && redis) { try { await write(redis, env, date, snap); } catch { /* cache is best-effort */ } }
    return snap;
  } finally {
    if (redis) { try { await redis.del(lockKey(env, date)); } catch {} }
  }
}

export interface ReadOpts {
  /** Skip the cache entirely and rebuild. The assign engine ALWAYS passes this: no
   *  assignment decision may be made from a cached day. A job created twenty seconds
   *  ago missing from the snapshot is exactly how a duplicate gets assigned. */
  fresh?: boolean;
}

type Slice = { jobs: SnapJob[]; builtAt: number | null; source: "cache" | "build" };

/** Read one index entry's jobs. Two round-trips by design: the index names the ids,
 *  then one HMGET brings back only those jobs. */
async function readSlice(
  redis: Redis, env: Env, date: string, indexField: string, indexKey: string,
): Promise<Slice | null> {
  const head = await redis.hmget<Record<string, unknown>>(key(env, date), BUILT, indexField);
  const builtAt = Number(head?.[BUILT] ?? 0);
  if (!builtAt) return null;
  const index = parse<Record<string, number[]>>(head?.[indexField], {});
  const ids = index[indexKey] ?? [];
  if (!ids.length) return { jobs: [], builtAt, source: "cache" };
  const rows = await redis.hmget<Record<string, unknown>>(key(env, date), ...ids.map(jobField));
  const jobs: SnapJob[] = [];
  for (const id of ids) {
    const j = parse<SnapJob | null>(rows?.[jobField(id)], null);
    if (j) jobs.push(j);
  }
  return { jobs, builtAt, source: "cache" };
}

async function slice(
  date: string, env: Env, indexField: string, indexKey: string,
  pick: (s: Snapshot) => number[], opts: ReadOpts,
): Promise<Slice | null> {
  const redis = getRedis();
  const fromSnap = (s: Snapshot): Slice => ({
    jobs: pick(s).map((id) => s.jobs.get(id)!).filter(Boolean),
    builtAt: s.builtAt, source: "build",
  });

  if (!redis) {
    const s = await buildSnapshot(date, env);
    return s ? fromSnap(s) : null;
  }
  if (!opts.fresh) {
    try {
      const hit = await readSlice(redis, env, date, indexField, indexKey);
      if (hit && hit.builtAt && Date.now() - hit.builtAt < MAX_AGE_MS) return hit;
      const built = await rebuild(redis, date, env);
      if (built) return fromSnap(built);
      // Someone else is rebuilding — serve what we already read rather than queue.
      if (hit) return hit;
    } catch { /* fall through to a direct build */ }
  }
  const built = await rebuild(redis, date, env);
  if (built) return fromSnap(built);
  const direct = await buildSnapshot(date, env);
  return direct ? fromSnap(direct) : null;
}

/** Drop the freshness stamp so the next read rebuilds. Called after creating or
 *  cancelling a job: the change is ours, we know the day is stale, and waiting out
 *  MAX_AGE_MS would let a just-created trip stay invisible to the duplicate guard.
 *  One HDEL — the job data stays put and is simply superseded by the rebuild. */
export async function invalidateSnapshot(date: string, env: Env): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try { await redis.hdel(key(env, date), BUILT); } catch { /* best-effort */ }
}

/** Every job touching this location today (either stop). null = the day is unavailable
 *  and the caller should use its own REST fallback. */
export async function locationJobs(
  date: string, env: Env, customerId: string, opts: ReadOpts = {},
): Promise<SnapJob[] | null> {
  const s = await slice(date, env, IDX_LOC, customerId, (snap) => snap.byLocation[customerId] ?? [], opts);
  return s?.jobs ?? null;
}

/** Every job assigned to this driver today. */
export async function driverJobs(
  date: string, env: Env, driverId: string, opts: ReadOpts = {},
): Promise<SnapJob[] | null> {
  const s = await slice(date, env, IDX_DRV, driverId, (snap) => snap.byDriver[driverId] ?? [], opts);
  return s?.jobs ?? null;
}

/** The blocking job for one pickup→dropoff pair, or null when nothing blocks it.
 *  `stale` reports the snapshot's age so a caller about to REFUSE a user can decide to
 *  confirm against live data first — a refusal issued from a cached reading is how a
 *  branch gets told to wait for a trip that already left. */
export async function blockedPair(
  date: string, env: Env, pairKey: string, opts: ReadOpts = {},
): Promise<{ hit: PairHit | null; ageMs: number | null } | null> {
  const redis = getRedis();
  if (redis && !opts.fresh) {
    try {
      const head = await redis.hmget<Record<string, unknown>>(key(env, date), BUILT, IDX_PAIRS);
      const builtAt = Number(head?.[BUILT] ?? 0);
      if (builtAt && Date.now() - builtAt < MAX_AGE_MS) {
        const pairs = parse<Record<string, PairHit>>(head?.[IDX_PAIRS], {});
        return { hit: pairs[pairKey] ?? null, ageMs: Date.now() - builtAt };
      }
    } catch { /* fall through */ }
  }
  const built = (await rebuild(redis, date, env)) ?? (await buildSnapshot(date, env));
  if (!built) return null;
  return { hit: built.pairs[pairKey] ?? null, ageMs: 0 };
}
