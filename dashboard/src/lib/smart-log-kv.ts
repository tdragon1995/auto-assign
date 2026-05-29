import { Redis } from "@upstash/redis";
import type { LogEntry } from "./types";

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
  mode: "smart" | "autoplan";
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

// ── Note-held jobs (for the dashboard note-review panel) ───────────────────

export interface HeldJob {
  job_id: number;
  customer: string;
  note: string;
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

/** Drop one job from the held list (after it's been assigned anyway). */
export async function removeHeldJob(jobId: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const next = (await getHeldJobs()).filter((j) => j.job_id !== jobId);
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

function shouldStore(entry: LogEntry): boolean {
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
