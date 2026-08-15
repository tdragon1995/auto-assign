import { Redis } from "@upstash/redis";
import type { LogEntry, PickupWarning, FailedJob } from "./types";

const KV_KEY = "smart:runs";
const MAX_RUNS = 240; // ~1 day at 3-min intervals × 12 business hours

const LAST_ASSIGN_KEY = "assign:last_run_ts";

// Server-side ON/OFF switch ("armed") for the cron-driven assign engine.
const ARM_KEY = "assign:arm_state";

// Per-cycle lock so two overlapping cron pings can't run a cycle at once.
const CYCLE_LOCK_KEY = "assign:cycle_lock";

// Gate for the periodic full REST sweep of the proxy driver's parked jobs
// (timeline mode sources the per-cycle release from the timeline payload, which
// only covers today — the sweep catches jobs stranded from a previous day).
const PROXY_SWEEP_KEY = "assign:proxy_sweep_ts";

// Liveness: timestamp of the last cron ping (armed or not), so the dashboard
// can show "System last checked: HH:MM" even when nothing was logged.
// Liveness, one field per deployment, keyed by DEPLOY_ID.
//
// This replaced a single `assign:heartbeat_ts` string. That key answered "did ANY
// ping arrive?", which stays green as long as one deployment is alive — fine with
// a single Vercel project, actively misleading with two, where a dead second
// account costs half the cycles while the dashboard still reads healthy. The hash
// answers "did EACH one ping?", and the newest field answers the old question too,
// so the separate key was a second write buying nothing (~20k commands/month at
// two accounts). The retired key carried a 24h TTL and expires on its own.
//
// One tiny field per deployment, so no TTL here; readers treat a field untouched
// for 24h as a deployment that was removed rather than one that is stale.
const DEPLOY_HEARTBEAT_KEY = "assign:heartbeat:deployments";

/** Stable per-project identity. Set DEPLOY_ID explicitly (e.g. "A" / "B").
 *  VERCEL_PROJECT_PRODUCTION_URL is the fallback because it survives redeploys,
 *  unlike VERCEL_URL which changes every build and would litter the hash with a
 *  new dead field on every push. */
const DEPLOY_ID =
  process.env.DEPLOY_ID || process.env.VERCEL_PROJECT_PRODUCTION_URL || "default";

// Jobs the last full cycle held back because a stop has a note. Refreshed each
// armed cycle; read by the dashboard's note-review panel (no Cartrack poll).
const HELD_JOBS_KEY = "assign:held_jobs";

// Pickup warnings computed from the last full cycle's assigned-jobs snapshot.
const PICKUP_WARNINGS_KEY = "assign:pickup_warnings";

// Jobs the last full cycle couldn't assign for a deterministic, recurring reason
// (no driver on duty, no mapping, driver clash, …). Snapshot, replaced each
// cycle; read by the dashboard "Cần xử lý" panel so the live log stops re-printing
// the same error every 3 minutes.
const FAILED_JOBS_KEY = "assign:failed_jobs";

// Server-backed live log: flat list of recent entries (all levels), so the
// dashboard ticker survives reloads and shows cycles that ran with no tab open.
const RUN_LOG_KEY = "assign:run_log";
const MAX_LOG_ENTRIES = 500;

function getRedis() {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export interface SmartRunEntry {
  ts: string;
  ok: number;
  warn: number;
  error: number;
  entries: LogEntry[];
}

function isSmartLog(entry: LogEntry): boolean {
  return entry.msg.includes("SMART") || entry.msg.includes("Smart-assign");
}

/** Persist smart-assign log entries from a completed assign cycle. */
export async function pushSmartRun(allLogs: LogEntry[]): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const entries = allLogs.filter(isSmartLog);
  if (entries.length === 0) return;

  const run: SmartRunEntry = {
    ts:    entries[0].ts,
    ok:    entries.filter((e) => e.level === "OK").length,
    warn:  entries.filter((e) => e.level === "WARN").length,
    error: entries.filter((e) => e.level === "ERROR").length,
    entries,
  };

  // One pipelined round-trip instead of three serial ones; order is preserved,
  // so push → trim → set-TTL keeps identical semantics (and stays atomic, so a
  // crash can't leave the list without its 24h TTL).
  const pipe = redis.pipeline();
  pipe.lpush(KV_KEY, JSON.stringify(run));
  pipe.ltrim(KV_KEY, 0, MAX_RUNS - 1);
  pipe.expire(KV_KEY, 86400); // hard 24-hour TTL
  await pipe.exec();
}

export interface LastRunEntry {
  ts: string;
  tabId: string;
}

/** Record that /api/assign was just called by tabId (fire-and-forget safe). */
export async function touchLastRun(tabId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const entry: LastRunEntry = { ts: new Date().toISOString(), tabId };
  await redis.set(LAST_ASSIGN_KEY, JSON.stringify(entry), { ex: 600 });
}

/** Return the last /api/assign entry, or null. */
export async function getLastRunEntry(): Promise<LastRunEntry | null> {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get<string | LastRunEntry>(LAST_ASSIGN_KEY);
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw) as LastRunEntry; } catch { return null; }
}

/** Read the most recent N runs (default 100). */
export async function getSmartRuns(limit = 100): Promise<SmartRunEntry[]> {
  const redis = getRedis();
  if (!redis) return [];

  const raw = await redis.lrange<string>(KV_KEY, 0, limit - 1);
  return raw.map((r) => (typeof r === "string" ? JSON.parse(r) : r) as SmartRunEntry);
}

// ── Server-side ON/OFF switch ("armed" state) ──────────────────────────────

export interface ArmState {
  armedUntil: number;          // epoch ms — engine assigns only while now < this
  armedTs: string;             // ISO time the switch was turned on
  armedBy: string;             // free-text label (no auth, so best-effort)
  env: "prod" | "uat";
}

function parseMaybe<T extends object>(raw: string | T | null): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

/** Current armed state, or null if disarmed/expired. Expiry is enforced here
 *  in addition to the Redis TTL, so a stale value can never assign. */
export async function getArmState(): Promise<ArmState | null> {
  const redis = getRedis();
  if (!redis) return null;
  const state = parseMaybe<ArmState>(await redis.get<string | ArmState>(ARM_KEY));
  if (!state) return null;
  if (Date.now() >= state.armedUntil) return null;
  return state;
}

/** Turn the switch on until `armedUntil`. TTL matches, so Redis self-clears. */
export async function setArmState(state: ArmState): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const ttlSec = Math.max(1, Math.ceil((state.armedUntil - Date.now()) / 1000));
  await redis.set(ARM_KEY, JSON.stringify(state), { ex: ttlSec });
}

/** Turn the switch off immediately. */
export async function clearArmState(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(ARM_KEY);
}

// ── Liveness heartbeat ─────────────────────────────────────────────────────

/** Record that the cron just pinged (called on every authorized ping).
 *
 *  ONE write. The old shared `assign:heartbeat_ts` key is gone: with a field per
 *  deployment, "has anything pinged?" is just the newest field, so keeping a
 *  separate key meant paying two writes for one fact. On ~680 pings/day across
 *  two accounts that second write was ~20k Redis commands a month for nothing. */
export async function setCronHeartbeat(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.hset(DEPLOY_HEARTBEAT_KEY, { [DEPLOY_ID]: new Date().toISOString() });
}

/** The newest stamp across deployments. ISO-8601 sorts lexicographically, so a
 *  string compare is a chronological one. */
function newestBeat(beats: DeploymentBeat[]): string | null {
  let newest: string | null = null;
  for (const b of beats) if (!newest || b.ts > newest) newest = b.ts;
  return newest;
}

/** ISO timestamp of the last cron ping from ANY deployment, or null. */
export async function getCronHeartbeat(): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.hgetall(DEPLOY_HEARTBEAT_KEY).catch(() => null);
  return newestBeat(parseDeploymentBeats(raw));
}

export interface DeploymentBeat {
  id: string;
  ts: string;
  /** False once this deployment has missed roughly two cron pings. */
  fresh: boolean;
}

// Same 6-minute window the header pill has always used for "stale".
const DEPLOY_STALE_MS = 6 * 60 * 1000;
// Past this, treat the deployment as removed rather than broken — otherwise a
// project you deliberately deleted would red the dashboard forever.
const DEPLOY_RETIRED_MS = 24 * 60 * 60 * 1000;

/** Parse the deployment hash into a freshness-tagged list, oldest problems
 *  visible to the caller. Unparseable or retired fields are dropped. */
function parseDeploymentBeats(raw: unknown): DeploymentBeat[] {
  if (!raw || typeof raw !== "object") return [];
  const now = Date.now();
  return Object.entries(raw as Record<string, string>)
    .map(([id, ts]) => ({ id, ts, age: now - new Date(ts).getTime() }))
    .filter((d) => Number.isFinite(d.age) && d.age < DEPLOY_RETIRED_MS)
    .map(({ id, ts, age }) => ({ id, ts, fresh: age < DEPLOY_STALE_MS }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ── Disarm record + business-hours alert debounce ───────────────────────────

// Who turned the switch off last (captured at disarm time, since clearArmState
// deletes the arm_state that holds armedBy). Read by the disarm alert email.
const LAST_DISARM_KEY = "assign:last_disarm";
// Debounce flag so the cron emails once per disarm episode, not every 3-min ping.
// Cleared on re-arm; otherwise a short TTL re-nudges if the engine stays off.
const DISARM_ALERT_KEY = "assign:disarm_alert_sent";

export interface DisarmRecord {
  by: string;       // operator name from dashboard localStorage (best-effort)
  ts: string;       // ISO time of the disarm
  reason?: string;  // "" for a manual off; e.g. "đổi môi trường" for auto-disarm
}

/** Record who turned the switch off (called by the DELETE arm handler). */
export async function setLastDisarm(by: string, reason?: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const rec: DisarmRecord = { by: by.slice(0, 60), ts: new Date().toISOString(), reason };
  await redis.set(LAST_DISARM_KEY, JSON.stringify(rec), { ex: 86400 });
}

/** Last disarm record, or null (e.g. engine was never armed today). */
export async function getLastDisarm(): Promise<DisarmRecord | null> {
  const redis = getRedis();
  if (!redis) return null;
  return parseMaybe<DisarmRecord>(await redis.get<string | DisarmRecord>(LAST_DISARM_KEY));
}

/** Atomically claim the right to send one disarm alert. Returns true only for
 *  the caller that set the flag; later pings get false until it's cleared/expires.
 *  No Redis ⇒ false (don't spam without a debounce store). */
export async function claimDisarmAlert(ttlSec = 10800): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  const res = await redis.set(DISARM_ALERT_KEY, new Date().toISOString(), { nx: true, ex: ttlSec });
  return res === "OK";
}

/** Clear the debounce flag so the next disarm episode re-alerts (called on arm). */
export async function clearDisarmAlert(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(DISARM_ALERT_KEY);
}

// ── Note-held jobs (for the dashboard note-review panel) ───────────────────

export interface HeldJob {
  job_id: number;
  customer: string;
  note: string;
  /** Set when a background approve/schedule failed and the job was put back. */
  error?: string;
  /** Who the job would go to once the note is cleared. Fixed-path jobs only —
   *  absent for smart jobs, whose driver isn't decided until assign time. The
   *  dashboard resolves this to a name against the Driver tab. */
  driver_id?: string;
  /** Display name, only when the engine knows one (a substitute, named by the
   *  leave row). The mapping sheet carries no names, so this is usually absent. */
  driver_name?: string;
  /** The on-leave driver being covered for, when the pick is a substitute. */
  sub_for?: string;
}

/** Replace the held-jobs list (called by a full cycle; pass [] to clear). */
export async function setHeldJobs(jobs: HeldJob[]): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(HELD_JOBS_KEY, JSON.stringify(jobs), { ex: 86400 });
}

/** Current held-jobs list. */
export async function getHeldJobs(): Promise<HeldJob[]> {
  const redis = getRedis();
  if (!redis) return [];
  const raw = await redis.get<string | HeldJob[]>(HELD_JOBS_KEY);
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw) as HeldJob[]; } catch { return []; }
}

// ── Unassignable jobs ("Cần xử lý" panel) ──────────────────────────────────

/** Replace the failed-jobs snapshot (called by a full cycle; pass [] to clear).
 *  24h TTL mirrors held jobs; the per-cycle replacement keeps it fresh, so a
 *  resolved job drops off on the next cycle and the morning's first cycle clears
 *  any leftovers from the day before. */
export async function setFailedJobs(jobs: FailedJob[]): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(FAILED_JOBS_KEY, JSON.stringify(jobs), { ex: 86400 });
}

/** Current failed-jobs snapshot. */
export async function getFailedJobs(): Promise<FailedJob[]> {
  const redis = getRedis();
  if (!redis) return [];
  const raw = await redis.get<string | FailedJob[]>(FAILED_JOBS_KEY);
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw) as FailedJob[]; } catch { return []; }
}

/** Replace the pickup-warning list (called at end of each full cycle).
 *  TTL is 10 min — short enough that stale warnings self-clear if cycles stop
 *  (e.g. system disarmed), but long enough to survive a couple missed pings. */
export async function setPickupWarnings(warnings: PickupWarning[]): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(PICKUP_WARNINGS_KEY, JSON.stringify(warnings), { ex: 600 });
}

/** Drop one job from the held list (after it's been assigned anyway). */
export async function removeHeldJob(jobId: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const next = (await getHeldJobs()).filter((j) => j.job_id !== jobId);
  await redis.set(HELD_JOBS_KEY, JSON.stringify(next), { ex: 86400 });
}

/** Add or update one job in the held list. Used when a background approve/schedule
 *  failed: the job is put back into the review panel (carrying its error) instead
 *  of vanishing. Upsert — replaces any existing entry for the same job_id. */
export async function addHeldJob(job: HeldJob): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const next = (await getHeldJobs()).filter((j) => j.job_id !== job.job_id);
  next.push(job);
  await redis.set(HELD_JOBS_KEY, JSON.stringify(next), { ex: 86400 });
}

// ── PSC active-pair overlay (write-through, for /api/psc-assign) ────────────
//
// WHY THIS EXISTS. The duplicate guard answers "is this pickup→dropoff already covered
// today?" from the day snapshot. That snapshot is published by the assign cycle every
// ~3 minutes, which makes the guard cheap (a read instead of a ~3s fleet-wide rebuild)
// but leaves a window: a trip booked 30 seconds ago is not in it yet. The guard's
// dangerous failure is a MISSING job — there is no suspect for stillBlocking to confirm,
// so a twin trip gets created and two drivers collect the same samples.
//
// This closes that window for every trip the APP creates: psc-assign records the pair the
// instant it books one, and the guard reads this alongside the snapshot. A job created by
// hand in Cartrack is still invisible until the next publish — that gap exists today too
// and only a live fetch could close it.
//
// ONE KEY PER PAIR, deliberately. The previous design (a single JSON blob rewritten
// read-modify-write) had a race its own comment acknowledged — "a rare concurrent-create
// clobber self-heals on the next cycle" — which was survivable only while the assign cycle
// rewrote the blob wholesale every cycle. Nothing rewrites it now, so a lost update would
// never heal. Independent keys have no such race and get their own expiry.
//
// STALE ENTRIES ARE SAFE, by design rather than by luck: psc-assign re-reads the live job
// (stillBlocking) before refusing anyone. An entry left behind after its pickup completed
// therefore costs one job fetch, not a wrong refusal — and psc-assign drops it when that
// happens. What must never happen is the opposite, a MISSING entry, which is exactly what
// this prevents.
const PSC_PAIR_PREFIX = "psc_pair:v1:";
// 6h: comfortably longer than a sample run, short enough that anything missed by the
// explicit unmarks (cancel, 3PL handoff) clears itself well within the day. Date-scoped
// keys mean yesterday's pairs can never block today regardless.
const PSC_PAIR_TTL_SEC = 6 * 60 * 60;

export interface PscDupHit {
  job_id: number;
  reference_number: string | null;
}

const pscPairRedisKey = (dateVn: string, pairKey: string) => `${PSC_PAIR_PREFIX}${dateVn}:${pairKey}`;

/** Record a just-booked pickup→dropoff so the guard sees it before the next publish. */
export async function markPscPair(dateVn: string, pairKey: string, hit: PscDupHit): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(pscPairRedisKey(dateVn, pairKey), JSON.stringify(hit), { ex: PSC_PAIR_TTL_SEC });
  } catch { /* best-effort: the snapshot still covers this pair once it publishes */ }
}

/** Drop a pair — the trip was cancelled, handed to a 3PL, or its pickup is already done.
 *  Without this the branch is made to wait for a live re-check on every later booking. */
export async function unmarkPscPair(dateVn: string, pairKey: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try { await redis.del(pscPairRedisKey(dateVn, pairKey)); } catch { /* best-effort */ }
}

/** The job this pair was last booked for, or null. One GET. */
export async function lookupPscPair(dateVn: string, pairKey: string): Promise<PscDupHit | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get<string | PscDupHit>(pscPairRedisKey(dateVn, pairKey));
    if (!raw) return null;
    const hit = typeof raw === "string" ? (JSON.parse(raw) as PscDupHit) : raw;
    return hit?.job_id ? hit : null;
  } catch {
    return null; // unreadable overlay must never block a booking; the snapshot still applies
  }
}

// ── Cross-instance create lock ──────────────────────────────────────────────
const CREATE_LOCK_PREFIX = "create_lock:";

/** 120s, now CONSERVATIVE rather than derived — the derivation it used to carry is gone.
 *
 *  It was sized as "Cartrack's indexing delay PLUS how stale the day snapshot may be",
 *  because the snapshot was the only thing that could tell the guard a job existed, and a
 *  brand-new job was invisible to it for that whole window. The pair overlay above now
 *  records a booking the instant it is made, so that window has collapsed to the moment
 *  between two racing requests — microseconds, not minutes.
 *
 *  Left at 120s deliberately anyway. It is the last line of defence if the overlay write
 *  fails (it is best-effort), and shortening it only helps a branch whose pickup was
 *  collected within two minutes of booking — rare, and already handled: stillBlocking sees
 *  the completed pickup and lets them straight through. Change it for a reason, not for
 *  tidiness. */
const CREATE_LOCK_TTL_SEC = 120;

export async function acquireCreateLock(key: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  const res = await redis.set(CREATE_LOCK_PREFIX + key, new Date().toISOString(), {
    nx: true,
    ex: CREATE_LOCK_TTL_SEC,
  });
  return res === "OK";
}

/** Release a creation lock (best-effort) — on create failure, or when a job is cancelled
 *  so the same identity can be re-requested without waiting out the TTL. */
export async function releaseCreateLock(key: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(CREATE_LOCK_PREFIX + key);
}

// ── Overlap lock — one cycle at a time, safe at any cron frequency ──────────

/** Try to claim the cycle lock. Returns true if claimed (caller may run the
 *  cycle), false if a cycle is already in flight. Auto-expires after ttlSec so
 *  a crashed cycle can't wedge the lock. When Redis is absent, always allows. */
export async function acquireCycleLock(ttlSec = 150): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  const res = await redis.set(CYCLE_LOCK_KEY, new Date().toISOString(), { nx: true, ex: ttlSec });
  return res === "OK";
}

/** Release the cycle lock (best-effort). */
export async function releaseCycleLock(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(CYCLE_LOCK_KEY);
}

/** True at most once per `ttlSec` (NX set) — gates the full REST sweep of the
 *  proxy driver's parked jobs. Without Redis, returns true so every cycle
 *  sweeps via REST (the pre-timeline behavior — fail-safe, never fail-silent). */
export async function shouldRunProxySweep(ttlSec = 1800): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  const res = await redis.set(PROXY_SWEEP_KEY, new Date().toISOString(), { nx: true, ex: ttlSec });
  return res === "OK";
}

/** Keyed by env so a manual UAT cycle can't consume prod's daily slot. */
const rolloverKey = (env: string, dateVn: string) => `assign:rollover_morning:${env}:${dateVn}`;

/** True at most once per VN day (NX set keyed by the date) — gates the morning
 *  rollover of yesterday's unfinished jobs into today's window. Without Redis,
 *  returns true so every cycle retries (fail-safe like the proxy sweep, and
 *  harmless: after the first pass yesterday's status-2 window is empty). */
export async function shouldRunDailyRollover(dateVn: string, env = "prod"): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  const res = await redis.set(rolloverKey(env, dateVn), new Date().toISOString(), { nx: true, ex: 172_800 });
  return res === "OK";
}

/** Hand the day's rollover slot back after a failed attempt, so a later cycle
 *  retries instead of leaving yesterday's leftovers stranded until tomorrow.
 *
 *  Claiming the slot before the work and releasing it on failure mirrors the TAT
 *  seal (`archiveSealedDays`). The difference: this SHORTENS the gate to
 *  `retrySec` rather than deleting it. A plain delete would retry on the very
 *  next 3-minute cycle, and the thing that fails here is a Cartrack list call
 *  that is already unwell (measured 2026-08-16: ~1 call in 3 returning HTTP 500)
 *  — hammering it every 3 minutes all morning would add two slow list fetches to
 *  every cycle. Ten minutes is still ~6 more attempts before the morning peak.  */
export async function deferDailyRollover(dateVn: string, env = "prod", retrySec = 600): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(rolloverKey(env, dateVn), new Date().toISOString(), { ex: retrySec }).catch(() => {});
}

/** Atomically claim the right to send ONE late-pickup Zalo alert for this job.
 *  Returns true only for the first cycle that sees the job cross the 2-hour mark;
 *  every later cycle gets false, so a job that stays stuck doesn't re-ping the
 *  supervisor group. 24h TTL is longer than any single delivery day, so the same
 *  job_id never double-alerts even after the day-boundary rollover re-dates it.
 *  Without Redis ⇒ false: no debounce store means we must not send at all (better
 *  silent than spamming the group every 3-min cycle). Env-scoped so a UAT cycle
 *  can't consume prod's slot — though alerts are prod-gated at the call site too. */
export async function claimLateAlert(jobId: number, env = "prod", ttlSec = 86400): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  const res = await redis.set(`assign:late_alert:${env}:${jobId}`, new Date().toISOString(), { nx: true, ex: ttlSec });
  return res === "OK";
}

// ── Trip-action claims — the cross-instance half of the in-flight guards ────

const tripClaimKey = (kind: string, env: string, jobId: number) =>
  `assign:trip_claim:${kind}:${env}:${jobId}`;

/** Atomically claim the right to create (return / via) or reject (cleanup) ONE
 *  trip for `jobId`. Covers the window between "we POSTed" and "Cartrack's job
 *  list shows it" — during that lag the list-derived dedup in return-trips.ts,
 *  via-legs.ts and cleanup-trips.ts is blind, and their in-memory Sets only
 *  guard a single lambda. This guards every instance, and every deployment
 *  sharing this Redis, which is what makes trip creation safe to run from more
 *  than one Vercel project at once.
 *
 *  Without Redis ⇒ true (fail-OPEN — the opposite of claimLateAlert). The
 *  in-memory Set is still in place at every call site, so this degrades to
 *  exactly the old single-instance behavior. Fail-closed would silently stop
 *  creating return trips fleet-wide on a Redis blip, which is far worse than a
 *  rare duplicate a dispatcher can cancel in one click. */
export async function claimTripAction(
  kind: "return" | "via" | "cleanup",
  jobId: number,
  env = "prod",
  ttlSec = 60
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  try {
    const res = await redis.set(tripClaimKey(kind, env, jobId), new Date().toISOString(), { nx: true, ex: ttlSec });
    return res === "OK";
  } catch {
    return true; // unreachable Redis — same fail-open reasoning as above
  }
}

/** Drop a claim after the action failed, so the next cycle retries instead of
 *  waiting out the TTL. Best-effort: a lost delete just means the retry waits
 *  up to `ttlSec`. */
export async function releaseTripClaim(
  kind: "return" | "via" | "cleanup",
  jobId: number,
  env = "prod"
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(tripClaimKey(kind, env, jobId));
  } catch {
    /* TTL is the backstop */
  }
}

// ── Server-backed live log ─────────────────────────────────────────────────

// Only these INFO lines are worth keeping; every other INFO is per-cycle noise
// ("No unassigned jobs", "Found N…", "Smart-assign ready", "Zalo sent",
// route-optimise-triggered) and is dropped from storage. OK/WARN/ERROR are
// always kept. Note-skip lines are intentionally NOT kept — they'd repeat every
// cycle for the same held job; the dashboard note-review panel shows them
// instead. (The WARN "assigning despite note" override line is still kept.)
const INFO_KEEP_PATTERNS = ["RELEASED", "PARKED", "ROLLED OVER", "swapped", "[fetch]", "[timing]", "[loop]", "[follow-ups]"];

// Deterministic per-job assign failures recur every cycle for the same job until
// a human fixes them — left in the rolling log they bury everything else (see the
// repeating "NO DRIVER ON DUTY" lines). The dashboard "Cần xử lý" panel shows the
// current snapshot instead, so these are dropped from the live log at any level.
// One-off action failures ("SMART failed", "Job failed", "… error") are NOT here
// — those are genuine events worth a log line. Match the panel's reason strings.
const LOG_DROP_PATTERNS = [
  "NO DRIVER ON DUTY",
  "NO MAPPING",
  "CLASH",                    // driver clash ("CLASH: N drivers on duty")
  "substitutes cover for",    // "Nhiều hơn 1 SUB" (renamed sub-clash)
  "no substitute covers now", // on-leave, no sub
  "invalid driver_id",
  "on-break or unavailable",  // all smart candidates unavailable
  "on-break or offline",      // single assigned driver unavailable (+ retry noise)
  "SMART skipped",            // pickup no GPS / 0 configured drivers available
  "is deactivated",           // assigned driver's Cartrack account disabled
  "deactivated account",      // same, per-candidate retry line in the smart loop
  "deactivated (",            // "no candidate assignable, N deactivated (…)"
];

function shouldStore(entry: LogEntry): boolean {
  if (LOG_DROP_PATTERNS.some((p) => entry.msg.includes(p))) return false;
  if (entry.level !== "INFO") return true;
  return INFO_KEEP_PATTERNS.some((p) => entry.msg.includes(p));
}

/** Append a cycle's important log entries to the rolling live-log list (24h TTL). */
export async function pushRunLog(logs: LogEntry[]): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const kept = logs.filter(shouldStore);
  if (kept.length === 0) return;
  // lpush in chronological order ⇒ newest entry ends up at the head. One
  // pipelined round-trip instead of three serial ones; order is preserved, so
  // push → trim → set-TTL is unchanged (and atomic — no TTL-less window on crash).
  const pipe = redis.pipeline();
  pipe.lpush(RUN_LOG_KEY, ...kept.map((l) => JSON.stringify(l)));
  pipe.ltrim(RUN_LOG_KEY, 0, MAX_LOG_ENTRIES - 1);
  pipe.expire(RUN_LOG_KEY, 86400);
  await pipe.exec();
}

/** Most recent N live-log entries in chronological order (oldest first). */
export async function getRunLog(limit = 300): Promise<LogEntry[]> {
  const redis = getRedis();
  if (!redis) return [];
  const raw = await redis.lrange<string>(RUN_LOG_KEY, 0, limit - 1);
  const entries = raw.map((r) => (typeof r === "string" ? JSON.parse(r) : r) as LogEntry);
  return entries.reverse();
}

export interface StatusBundle {
  state: ArmState | null;
  lastChecked: string | null;
  /** One entry per deployment that has pinged in the last 24h. Single-account
   *  setups get exactly one; the dashboard only surfaces this when there are
   *  two or more. */
  deployments: DeploymentBeat[];
  logs: LogEntry[];
  held: HeldJob[];
  warnings: PickupWarning[];
  failed: FailedJob[];
}

/** One pipeline request to Upstash instead of 6 separate HTTP calls. */
export async function getStatusBundle(logLimit = 100): Promise<StatusBundle> {
  const redis = getRedis();
  if (!redis) return { state: null, lastChecked: null, deployments: [], logs: [], held: [], warnings: [], failed: [] };

  const pipe = redis.pipeline();
  pipe.get(ARM_KEY);
  pipe.lrange(RUN_LOG_KEY, 0, logLimit - 1);
  pipe.get(HELD_JOBS_KEY);
  pipe.get(PICKUP_WARNINGS_KEY);
  pipe.get(FAILED_JOBS_KEY);
  pipe.hgetall(DEPLOY_HEARTBEAT_KEY);
  const [rawState, rawLogs, rawHeld, rawWarnings, rawFailed, rawDeployments] = await pipe.exec();

  const state = parseMaybe<ArmState>(rawState as string | ArmState | null);
  const validState = state && Date.now() < state.armedUntil ? state : null;

  // Derived from the per-deployment hash rather than its own key — one less
  // command per poll, and the two can no longer disagree.
  const deployments = parseDeploymentBeats(rawDeployments);
  const lastChecked = newestBeat(deployments);

  const logEntries = ((rawLogs as (string | LogEntry)[]) ?? [])
    .map((r) => (typeof r === "string" ? JSON.parse(r) : r) as LogEntry)
    .reverse();

  let held: HeldJob[] = [];
  if (rawHeld) {
    if (Array.isArray(rawHeld)) held = rawHeld as HeldJob[];
    else if (typeof rawHeld === "string") {
      try { held = JSON.parse(rawHeld); } catch { /* ignore */ }
    }
  }

  let warnings: PickupWarning[] = [];
  if (rawWarnings) {
    if (Array.isArray(rawWarnings)) warnings = rawWarnings as PickupWarning[];
    else if (typeof rawWarnings === "string") {
      try { warnings = JSON.parse(rawWarnings); } catch { /* ignore */ }
    }
  }

  let failed: FailedJob[] = [];
  if (rawFailed) {
    if (Array.isArray(rawFailed)) failed = rawFailed as FailedJob[];
    else if (typeof rawFailed === "string") {
      try { failed = JSON.parse(rawFailed); } catch { /* ignore */ }
    }
  }

  return {
    state: validState,
    lastChecked,
    deployments,
    logs: logEntries,
    held,
    warnings,
    failed,
  };
}
