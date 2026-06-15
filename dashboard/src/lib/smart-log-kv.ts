import { Redis } from "@upstash/redis";
import type { LogEntry, PickupWarning, FailedJob } from "./types";

const KV_KEY = "smart:runs";
const MAX_RUNS = 240; // ~1 day at 3-min intervals × 12 business hours

const LAST_ASSIGN_KEY = "assign:last_run_ts";

// Server-side ON/OFF switch ("armed") for the cron-driven assign engine.
const ARM_KEY = "assign:arm_state";

// Per-cycle lock so two overlapping cron pings can't run a cycle at once.
const CYCLE_LOCK_KEY = "assign:cycle_lock";

// Liveness: timestamp of the last cron ping (armed or not), so the dashboard
// can show "System last checked: HH:MM" even when nothing was logged.
const HEARTBEAT_KEY = "assign:heartbeat_ts";

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

  await redis.lpush(KV_KEY, JSON.stringify(run));
  await redis.ltrim(KV_KEY, 0, MAX_RUNS - 1);
  await redis.expire(KV_KEY, 86400); // hard 24-hour TTL
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

/** Record that the cron just pinged (called on every authorized ping). */
export async function setCronHeartbeat(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(HEARTBEAT_KEY, new Date().toISOString(), { ex: 86400 });
}

/** ISO timestamp of the last cron ping, or null. */
export async function getCronHeartbeat(): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get<string>(HEARTBEAT_KEY);
  return raw ?? null;
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

// ── Server-backed live log ─────────────────────────────────────────────────

// Only these INFO lines are worth keeping; every other INFO is per-cycle noise
// ("No unassigned jobs", "Found N…", "Smart-assign ready", "Zalo sent",
// route-optimise-triggered) and is dropped from storage. OK/WARN/ERROR are
// always kept. Note-skip lines are intentionally NOT kept — they'd repeat every
// cycle for the same held job; the dashboard note-review panel shows them
// instead. (The WARN "assigning despite note" override line is still kept.)
const INFO_KEEP_PATTERNS = ["RELEASED", "PARKED", "swapped"];

// Deterministic per-job assign failures recur every cycle for the same job until
// a human fixes them — left in the rolling log they bury everything else (see the
// repeating "NO DRIVER ON DUTY" lines). The dashboard "Cần xử lý" panel shows the
// current snapshot instead, so these are dropped from the live log at any level.
// One-off action failures ("SMART failed", "Job failed", "… error") are NOT here
// — those are genuine events worth a log line. Match the panel's reason strings.
const LOG_DROP_PATTERNS = [
  "NO DRIVER ON DUTY",
  "NO MAPPING",
  "CLASH",                    // covers "CLASH:" and "SUB CLASH"
  "no substitute covers now", // on-leave, no sub
  "invalid driver_id",
  "on-break or unavailable",  // all smart candidates unavailable
  "on-break or offline",      // single assigned driver unavailable (+ retry noise)
  "SMART skipped",            // pickup no GPS / 0 configured drivers available
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
  // lpush in chronological order ⇒ newest entry ends up at the head.
  await redis.lpush(RUN_LOG_KEY, ...kept.map((l) => JSON.stringify(l)));
  await redis.ltrim(RUN_LOG_KEY, 0, MAX_LOG_ENTRIES - 1);
  await redis.expire(RUN_LOG_KEY, 86400);
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
  logs: LogEntry[];
  held: HeldJob[];
  warnings: PickupWarning[];
  failed: FailedJob[];
}

/** One pipeline request to Upstash instead of 6 separate HTTP calls. */
export async function getStatusBundle(logLimit = 100): Promise<StatusBundle> {
  const redis = getRedis();
  if (!redis) return { state: null, lastChecked: null, logs: [], held: [], warnings: [], failed: [] };

  const pipe = redis.pipeline();
  pipe.get(ARM_KEY);
  pipe.get(HEARTBEAT_KEY);
  pipe.lrange(RUN_LOG_KEY, 0, logLimit - 1);
  pipe.get(HELD_JOBS_KEY);
  pipe.get(PICKUP_WARNINGS_KEY);
  pipe.get(FAILED_JOBS_KEY);
  const [rawState, rawHeartbeat, rawLogs, rawHeld, rawWarnings, rawFailed] = await pipe.exec();

  const state = parseMaybe<ArmState>(rawState as string | ArmState | null);
  const validState = state && Date.now() < state.armedUntil ? state : null;

  const lastChecked = typeof rawHeartbeat === "string" ? rawHeartbeat : null;

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

  return { state: validState, lastChecked, logs: logEntries, held, warnings, failed };
}
