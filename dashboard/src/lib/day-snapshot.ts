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
 *  the branch's screen may look when nobody has touched anything.
 *
 *  60s is a deliberate midpoint: still comfortably under the observed request gap, so
 *  most reads rebuild, but it halves how stale a screen can be versus 90s. Nothing warms
 *  this in the background — the assign cycle fetches its own routes and never touches
 *  the snapshot, by design (no assignment decision may read a cache), so the rebuild
 *  rate follows display traffic alone.
 *
 *  COUPLED to CREATE_LOCK_TTL_SEC in smart-log-kv: that lock is what stops a second
 *  request creating a twin while a just-created job is still invisible to the dedup
 *  query, and this value is part of how long "still invisible" lasts. Raising this
 *  without raising the lock reopens that gap. */
export const MAX_AGE_MS = 60_000;

/** How stale the BRANCH FEED may be. Deliberately looser than MAX_AGE_MS, because
 *  freshness is worth different amounts to different readers and one global number was
 *  charging the cheapest reader the strictest price.
 *
 *  Measured 2026-08-03: 406 feed requests in 12h forced ~302 full rebuilds of the whole
 *  network's day — 74% — because any request arriving more than 60s after the last one
 *  rebuilt everything just to render one branch's dozen rows. At 5 minutes that falls to
 *  roughly a third, and booking traffic (which keeps its 60s window) refreshes the day
 *  often enough that feeds mostly read a picture someone else already paid for.
 *
 *  Safe here and NOT safe for the duplicate guard, for an asymmetric reason: the guard
 *  re-checks the live job before refusing anyone, which catches a stale picture that
 *  wrongly says "blocked" — but nothing catches a stale picture that is simply MISSING a
 *  job, because then there is no suspect to confirm and a twin trip gets created. The
 *  feed has no such failure: the worst case is a branch seeing a trip's progress a few
 *  minutes late, and Làm mới still forces a live read. */
export const FEED_MAX_AGE_MS = 300_000;

/** Hash lifetime. Long enough that a quiet stretch doesn't force a cold rebuild,
 *  short enough that a stale day self-clears. Freshness is decided by __built__,
 *  not by this. */
const HASH_TTL_S = 900;

/** Guards a rebuild so several readers crossing the freshness line in the same second
 *  don't all parse the day at once. The loser serves what's already cached. */
const LOCK_TTL_S = 20;

/** Freshness stamp trusted by EVERY reader, including the duplicate guard. Written only
 *  by an on-demand rebuild — i.e. by a reader that fetched the day itself, at the moment
 *  it needed it. */
const BUILT = "__built__";

/** Freshness stamp trusted by the DISPLAY readers only (branch feed, chấm-công).
 *  Written by on-demand rebuilds AND by the assign cycle's publish.
 *
 *  Two stamps, not one, because the cycle can only publish the day as it looked when it
 *  FETCHED — and it goes on to create jobs after that: via-legs and return trips, made
 *  during the same run. A published snapshot is therefore knowably incomplete, and the
 *  one reader that must never see an incomplete day is the duplicate guard, whose failure
 *  mode is a missing job (no suspect to confirm → a twin trip gets created). The feed's
 *  worst case is a leg appearing a couple of minutes late.
 *
 *  Today those follow-up jobs can't actually collide with a branch booking — pscPairKey
 *  is directional and return trips run base→PSC, the reverse of a booking, while via-legs
 *  are excluded from the pair index by label. That is an argument for safety, not a
 *  guarantee of it: it holds because of how two other modules happen to behave, and
 *  nothing would fail loudly if either changed. Splitting the stamp means the guard never
 *  depends on that reasoning being true. */
const BUILT_FEED = "__built_feed__";

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
  return assembleSnapshot(timeline, unrouted, Date.now());
}

/** The parse half of buildSnapshot, split out so a caller that ALREADY holds both
 *  payloads can assemble a snapshot without re-fetching them. `builtAt` is passed in
 *  rather than read from the clock: the assign cycle assembles ~10-30s after its fetch,
 *  and stamping the write time would claim a freshness the data does not have. */
export function assembleSnapshot(
  timeline: Job[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unrouted: any[] | null,
  builtAt: number,
): Snapshot {
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

  return { jobs, byLocation, byDriver, pairs: buildPairs(all), builtAt };
}

/** `stamps: "all"` marks the day fresh for every reader; `"feed"` marks it fresh only for
 *  the display readers and leaves the guard's stamp absent, so the guard rebuilds. */
async function write(
  redis: Redis, env: Env, date: string, snap: Snapshot, stamps: "all" | "feed" = "all",
): Promise<void> {
  const fields: Record<string, string> = {
    [BUILT_FEED]: String(snap.builtAt),
    ...(stamps === "all" ? { [BUILT]: String(snap.builtAt) } : {}),
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
  /** How stale this particular reader will accept, overriding MAX_AGE_MS. Lets the branch
   *  feed ride on a picture the duplicate guard already refreshed instead of forcing its
   *  own rebuild. Ignored when `fresh` is set. */
  maxAgeMs?: number;
}

type Slice = { jobs: SnapJob[]; builtAt: number | null; source: "cache" | "build" };

/** Read one index entry's jobs. Two round-trips by design: the index names the ids,
 *  then one HMGET brings back only those jobs. */
async function readSlice(
  redis: Redis, env: Env, date: string, indexField: string, indexKey: string,
  stampField: string,
): Promise<Slice | null> {
  const head = await redis.hmget<Record<string, unknown>>(key(env, date), stampField, indexField);
  const builtAt = Number(head?.[stampField] ?? 0);
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

/** Display reads pass BUILT_FEED so they can ride on a cycle-published day; anything
 *  feeding a decision reads BUILT and therefore only ever sees a reader-built one. */
async function slice(
  date: string, env: Env, indexField: string, indexKey: string,
  pick: (s: Snapshot) => number[], opts: ReadOpts, stampField: string = BUILT,
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
      const hit = await readSlice(redis, env, date, indexField, indexKey, stampField);
      if (hit && hit.builtAt && Date.now() - hit.builtAt < (opts.maxAgeMs ?? MAX_AGE_MS)) return hit;
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

/** Drop a freshness stamp so the next read rebuilds. Called after creating or cancelling
 *  a job: the change is ours, we know the day is stale, and waiting out the tolerance
 *  would let a just-created trip stay invisible. One HDEL — the job data stays put and is
 *  simply superseded by the rebuild.
 *
 *  `scope` decides WHO is made to pay for that rebuild, and the choice is not cosmetic:
 *
 *  - `"guard"` — clears only the duplicate guard's stamp. For callers whose UI updates
 *    itself from the action's own response (psc-assign: the branch's list is patched
 *    client-side). The guard must still see the new job, but no display reader should
 *    rebuild the whole network's day on account of one branch's booking.
 *  - `"all"` — also clears the display stamp, for callers that still re-read a list after
 *    acting (chấm-công). Without it the driver reloads and their brand-new check-in is
 *    missing, which reads as the tap having failed.
 *
 *  Default is `"all"`: a caller that forgets to think about this gets the conservative
 *  behaviour, which costs CPU rather than correctness. */
export async function invalidateSnapshot(
  date: string, env: Env, scope: "all" | "guard" = "all",
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const fields = scope === "all" ? [BUILT, BUILT_FEED] : [BUILT];
  try { await redis.hdel(key(env, date), ...fields); } catch { /* best-effort */ }
}

/** Publish a day the ASSIGN CYCLE already fetched, for the display readers only.
 *
 *  The cycle pulls delivery_timeline_route_list + delivery_jobs_list_new every ~3 minutes
 *  and used to discard both. Those are precisely the two payloads buildSnapshot fetches,
 *  so handing them over costs no Cartrack call — just the parse and one Redis write. The
 *  feed tolerates FEED_MAX_AGE_MS (300s) against a 180s cycle, so a branch opening its
 *  list now almost always reads a day the cron already paid for.
 *
 *  `fetchedAt` must be when the payloads were FETCHED, not now: the cycle assembles well
 *  after its fetch, and an honest stamp is what keeps the age arithmetic meaningful for
 *  every reader downstream.
 *
 *  Skips the write if a reader has published something newer. Without that check a cycle
 *  that started before an on-demand rebuild would overwrite it with older data and, worse,
 *  strip the BUILT stamp that rebuild had just earned — making the guard pay for another. */
export async function publishSnapshot(
  date: string, env: Env, timeline: Job[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unrouted: any[] | null, fetchedAt: number,
): Promise<"written" | "superseded" | "skipped"> {
  const redis = getRedis();
  if (!redis) return "skipped";
  try {
    const existing = Number(await redis.hget(key(env, date), BUILT_FEED));
    if (existing && existing >= fetchedAt) return "superseded";
    await write(redis, env, date, assembleSnapshot(timeline, unrouted, fetchedAt), "feed");
    return "written";
  } catch {
    return "skipped"; // publishing is an optimisation; never fail a cycle over it
  }
}

/** Every job touching this location today (either stop). null = the day is unavailable
 *  and the caller should use its own REST fallback. */
export async function locationJobs(
  date: string, env: Env, customerId: string, opts: ReadOpts = {},
): Promise<SnapJob[] | null> {
  // Defaults to the looser feed tolerance — this is the branch's status display, the one
  // reader for which a few minutes late costs nothing. A caller wanting the strict window
  // can still pass maxAgeMs, and `fresh` overrides both.
  const s = await slice(date, env, IDX_LOC, customerId,
    (snap) => snap.byLocation[customerId] ?? [],
    { maxAgeMs: FEED_MAX_AGE_MS, ...opts }, BUILT_FEED);
  return s?.jobs ?? null;
}

/** Every job assigned to this driver today. Display-only (chấm-công's list of a driver's
 *  check-in/out jobs), so it reads the feed stamp too. */
export async function driverJobs(
  date: string, env: Env, driverId: string, opts: ReadOpts = {},
): Promise<SnapJob[] | null> {
  const s = await slice(date, env, IDX_DRV, driverId,
    (snap) => snap.byDriver[driverId] ?? [], opts, BUILT_FEED);
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
