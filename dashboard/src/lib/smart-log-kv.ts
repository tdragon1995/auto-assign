import { Redis } from "@upstash/redis";
import { vnDate, vnMinutesSinceMidnight, vnTimestamp } from "./time";
import { isNoteReleaseHour } from "./job-filters";
import type { LogEntry, PickupWarning, FailedJob, SheetAlarm, UnfinishedConfigRow, CoverageGap, BranchRule } from "./types";

/**
 * COMMAND BUDGET — read this before adding a Redis call to a per-cycle path.
 *
 * Upstash bills per COMMAND, and counts every command inside a pipeline or MULTI
 * separately. Pipelining cuts round-trips and latency; it does not cut the bill.
 * At ~660 armed cycles a day, one extra command per cycle is ~20k commands a
 * month, and the free tier stops accepting writes at 500k.
 *
 * Measured 2026-08-18: 20.3k commands/day, on pace for ~609k that month. The
 * shape of the waste was gates — a once-a-day question asked 660 times, because
 * "claim if absent" is a WRITE whether or not it claims anything. Hence the
 * daily-claim helpers below, and hence held/failed/warnings living in one hash
 * instead of three keys.
 *
 * Multiply by 660 and by 30 before you add anything here.
 */

const LAST_ASSIGN_KEY = "assign:last_run_ts";

// Server-side ON/OFF switch ("armed") for the cron-driven assign engine.
const ARM_KEY = "assign:arm_state";

// Per-cycle lock so two overlapping cron pings can't run a cycle at once.
const CYCLE_LOCK_KEY = "assign:cycle_lock";

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

// ── Per-cycle dashboard snapshot: held + failed + pickup warnings ───────────
//
// ONE hash, not three keys. All three are whole-value snapshots the cycle replaces
// together, so they were three SETs buying what one HSET buys: an HSET writing
// three named fields is ONE command. The cycle writes this twice (an early exit
// after "no unassigned jobs", and the full end-of-cycle pass), so this took the
// per-cycle cost from 5 commands to 2, and the dashboard poll from 6 to 4.
//
//   held      — jobs held back because a stop has a note (note-review panel)
//   failed    — jobs unassignable for a deterministic, recurring reason (no driver
//               on duty, no mapping, clash…). Read by the "Cần xử lý" panel so the
//               live log stops re-printing the same error every 3 minutes.
//   warnings  — pickup warnings from the last full cycle's assigned-jobs snapshot
//
// WARNINGS CARRY THEIR OWN TIMESTAMP because they used to carry their own 10-minute
// TTL, whose job was to self-clear stale warnings if cycles stopped (e.g. the engine
// was disarmed). One key means one expiry, so that guarantee moved from Redis to the
// reader: `warnings_ts` is written alongside, and getStatusBundle drops warnings
// older than WARNINGS_MAX_AGE_MS. Held and failed never needed this — they are
// replaced every cycle and cleared by the morning's first pass.
const CYCLE_SNAPSHOT_KEY = "assign:cycle_snapshot";
const F_HELD = "held";
const F_FAILED = "failed";
const F_WARNINGS = "warnings";
const F_WARNINGS_TS = "warnings_ts";
// Tabs the engine currently refuses to read. Written only when the set CHANGES
// (see drainSheetAlarms), so a healthy day costs nothing — and it rides the same
// HSET as the fields above, which is one command regardless of how many fields
// it carries.
const F_SHEET_ALARMS = "sheet_alarms";
// Branches with a config line but no driver — read back out of the sheet, which
// is where they are recorded. Published with the rest so the dashboard can show
// them whether or not anything is failing at this moment: unlike a stuck job,
// an unfinished row is waiting on a person indefinitely and would otherwise be
// visible only to someone who thought to open the workbook.
const F_UNFINISHED = "unfinished_config";
// Hours a job needed and nobody was on, still uncovered as of the last parse.
const F_GAPS = "coverage_gaps";
// When the sheet behind those two lists was last actually read.
const F_PARSED_AT = "config_parsed_at";
const F_BRANCH_RULES = "config_branch_rules";
const WARNINGS_MAX_AGE_MS = 600_000; // 10 min — what the old PICKUP_WARNINGS TTL enforced

// Server-backed live log: flat list of recent entries (all levels), so the
// dashboard ticker survives reloads and shows cycles that ran with no tab open.
const RUN_LOG_KEY = "assign:run_log";

// Kept by the once-a-day trim. Higher than the old per-cycle cap of 500 because
// the trim is no longer per-cycle: the list is allowed to run a day long (~3k
// entries, ~500 KB) and is cut back each morning. That costs nothing to read —
// every reader takes the newest 100 off the head — and gives the dashboard MORE
// history than the old hard cap did, for two fewer commands per cycle.
const DAILY_LOG_KEEP = 1000;

// 48h, refreshed once a day. NOT 24h: a once-a-day refresh of a 24h TTL expires at
// the very moment the next refresh is due, so one late or skipped cycle would wipe
// the log outright. Doubling it leaves a full day of slack.
const DAILY_TTL_S = 172_800;

function getRedis() {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
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

// ── Sticky manual off ──────────────────────────────────────────────────────

// Turning the switch off is a decision, not a fault, so it HOLDS until someone
// presses it back on. Deliberately no TTL: any expiry would hand the day back to
// the cron's auto-arm, which is the exact behaviour this key exists to stop.
// Cleared only by an arm.
const ARM_HOLD_KEY = "assign:arm_hold";

export interface ArmHold {
  by: string;  // who turned it off (best-effort, from the dashboard)
  ts: string;  // ISO time of the off
}

/** Hold the engine off until someone arms it again. */
export async function setArmHold(by: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const hold: ArmHold = { by: by.slice(0, 60), ts: new Date().toISOString() };
  await redis.set(ARM_HOLD_KEY, JSON.stringify(hold));
}

/** The standing manual off, or null when none is in force. */
export async function getArmHold(): Promise<ArmHold | null> {
  const redis = getRedis();
  if (!redis) return null;
  return parseMaybe<ArmHold>(await redis.get<string | ArmHold>(ARM_HOLD_KEY));
}

/** Release the hold — called on every arm, so auto-arm resumes from then on. */
export async function clearArmHold(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(ARM_HOLD_KEY);
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

/** Parse a snapshot field that may come back as a JSON string or already-decoded. */
function parseList<T>(raw: unknown): T[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as T[]; } catch { return []; }
  }
  return [];
}

export interface CycleSnapshot {
  held?: HeldJob[];
  failed?: FailedJob[];
  warnings?: PickupWarning[];
  sheetAlarms?: SheetAlarm[];
  unfinished?: UnfinishedConfigRow[];
  gaps?: CoverageGap[];
  parsedAt?: string;
  branchRules?: Record<string, BranchRule[]>;
}

/** Replace part or all of the per-cycle snapshot in ONE command.
 *
 *  Pass only what this call site actually computed: the early "no unassigned jobs"
 *  exit knows held+failed but not warnings, and must not blank warnings it never
 *  looked at. Omitted fields are left untouched.
 *
 *  No EXPIRE here — that would put the per-cycle command back. The key is rewritten
 *  every cycle and never deleted, so its TTL is refreshed once a day by
 *  runDailyMaintenance(). */
export async function setCycleSnapshot(snap: CycleSnapshot): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const fields: Record<string, string> = {};
  if (snap.held)     fields[F_HELD]   = JSON.stringify(snap.held);
  if (snap.failed)   fields[F_FAILED] = JSON.stringify(snap.failed);
  if (snap.warnings) {
    fields[F_WARNINGS]    = JSON.stringify(snap.warnings);
    fields[F_WARNINGS_TS] = String(Date.now());
  }
  if (snap.sheetAlarms) fields[F_SHEET_ALARMS] = JSON.stringify(snap.sheetAlarms);
  if (snap.unfinished)  fields[F_UNFINISHED]   = JSON.stringify(snap.unfinished);
  if (snap.gaps)        fields[F_GAPS]         = JSON.stringify(snap.gaps);
  if (snap.parsedAt)    fields[F_PARSED_AT]   = snap.parsedAt;
  if (snap.branchRules) fields[F_BRANCH_RULES] = JSON.stringify(snap.branchRules);
  if (Object.keys(fields).length === 0) return;
  await redis.hset(CYCLE_SNAPSHOT_KEY, fields);
}

/** Current held-jobs list. */
export async function getHeldJobs(): Promise<HeldJob[]> {
  const redis = getRedis();
  if (!redis) return [];
  return parseList<HeldJob>(await redis.hget(CYCLE_SNAPSHOT_KEY, F_HELD));
}

/** Current failed-jobs snapshot ("Cần xử lý" panel). */
export async function getFailedJobs(): Promise<FailedJob[]> {
  const redis = getRedis();
  if (!redis) return [];
  return parseList<FailedJob>(await redis.hget(CYCLE_SNAPSHOT_KEY, F_FAILED));
}

/** Drop one job from the held list (after it's been assigned anyway). */
export async function removeHeldJob(jobId: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const next = (await getHeldJobs()).filter((j) => j.job_id !== jobId);
  await redis.hset(CYCLE_SNAPSHOT_KEY, { [F_HELD]: JSON.stringify(next) });
}

/** Add or update one job in the held list. Used when a background approve/schedule
 *  failed: the job is put back into the review panel (carrying its error) instead
 *  of vanishing. Upsert — replaces any existing entry for the same job_id. */
export async function addHeldJob(job: HeldJob): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const next = (await getHeldJobs()).filter((j) => j.job_id !== job.job_id);
  next.push(job);
  await redis.hset(CYCLE_SNAPSHOT_KEY, { [F_HELD]: JSON.stringify(next) });
}

// ── Learning which notes are harmless ───────────────────────────────────────
//
// Every "Giao ngay" is a supervisor saying "this sentence did not change the
// job". Every "Hẹn giờ" is them saying the opposite. Counting those two is all
// the evidence needed to spot the next sentence worth adding to the safe list —
// and it is evidence the engine can gather on its own, so nobody has to re-run
// a report or ship a code change to grow the list.
//
// The engine PROPOSES; a human accepts. Deliberately not self-promoting: the
// same automatic test that produced the seeded list also proposed "19h" and
// "lấy mẫu trước 5 giờ giúp e ạ", both of which name an hour and both of which
// a person rejected on sight. And promotion cuts its own feedback wire — once a
// sentence is on the list its jobs stop reaching the review panel, so nobody can
// ever reschedule one, so the counter can never learn it was wrong. Acceptance
// is the last moment anyone reads the sentence.
const NOTE_LEARN_KEY = "assign:note_learn";

/** Clean approvals needed before a sentence is proposed. Consecutive: one
 *  "Hẹn giờ" on that sentence puts the count back to zero. */
export const NOTE_LEARN_THRESHOLD = 3;

export interface NoteLearnEntry {
  /** Consecutive "Giao ngay" approvals since the last reschedule. */
  ok: number;
  /** Times a supervisor answered this sentence with "Hẹn giờ" instead. */
  sched: number;
  /** The sentence as a branch actually typed it, for showing on the suggestion. */
  sample: string;
  /** When it was last counted (VN timestamp), so a stale suggestion is visible. */
  last: string;
  /** Absent while still counting. */
  state?: "accepted" | "dismissed";
}

type NoteLearnMap = Record<string, NoteLearnEntry>;

async function readNoteLearning(): Promise<NoteLearnMap> {
  const redis = getRedis();
  if (!redis) return {};
  const raw = await redis.hgetall(NOTE_LEARN_KEY).catch(() => null);
  const out: NoteLearnMap = {};
  for (const [k, v] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    const e = parseMaybe<NoteLearnEntry>(v as string | NoteLearnEntry);
    if (e && typeof e.ok === "number") out[k] = e;
  }
  return out;
}

/** Everything the dashboard needs: what is accepted, and what is being proposed. */
export async function getNoteLearning(): Promise<{
  accepted: NoteLearnEntry[];
  suggestions: NoteLearnEntry[];
}> {
  const map = await readNoteLearning();
  const accepted: NoteLearnEntry[] = [];
  const suggestions: NoteLearnEntry[] = [];
  for (const e of Object.values(map)) {
    if (e.state === "accepted") accepted.push(e);
    else if (!e.state && e.ok >= NOTE_LEARN_THRESHOLD) suggestions.push(e);
  }
  suggestions.sort((a, b) => b.ok - a.ok);
  accepted.sort((a, b) => a.sample.localeCompare(b.sample));
  return { accepted, suggestions };
}

// COMMAND BUDGET (see the header): read once per cycle this would be ~20k a
// month, which is exactly the kind of addition that comment warns about. It is
// cached in the instance instead. The list changes once or twice a MONTH, so a
// ten-minute copy is not a compromise — a newly accepted sentence taking one
// more cycle or two to take effect is nothing against the wait it removes, and
// the accepting instance drops its own copy immediately.
//
// Only armed cycles reach this, so the overnight pings pay nothing. A cold start
// pays one cheap HGETALL, which is the honest floor: the alternative is holding
// the list in the code and shipping a deploy for every sentence.
const SAFE_NOTES_TTL_MS = 10 * 60_000;
let safeNotesCache: { at: number; set: ReadonlySet<string> } | null = null;

/** Accepted sentences, cached. Returns an empty set when Redis is unreachable —
 *  the engine then runs on the reviewed code list alone, which is the safe way
 *  to fail: notes hold, exactly as they did before any of this existed. */
export async function getAcceptedNotes(): Promise<ReadonlySet<string>> {
  if (safeNotesCache && Date.now() - safeNotesCache.at < SAFE_NOTES_TTL_MS) {
    return safeNotesCache.set;
  }
  try {
    const map = await readNoteLearning();
    const set = new Set(
      Object.entries(map).filter(([, e]) => e.state === "accepted").map(([k]) => k),
    );
    safeNotesCache = { at: Date.now(), set };
    return set;
  } catch {
    return safeNotesCache?.set ?? new Set<string>();
  }
}

/** Drop the cached copy so an acceptance takes effect on the next cycle rather
 *  than up to five minutes later. Only helps the instance that handled the
 *  click; the rest catch up on their own TTL. */
export function invalidateAcceptedNotes(): void {
  safeNotesCache = null;
}

/**
 * The counting rule, on its own so it can be checked without a Redis.
 *
 * An approval adds one to the run. Anything else zeroes it and records the
 * reschedule, so it always takes three CLEAN approvals in a row — a sentence
 * approved twice, rescheduled, then approved twice more is back at two, not
 * four. Returns null for a sentence already accepted or dismissed: that
 * decision stands, and re-counting it would only churn.
 */
export type NoteDecision = "approved" | "rescheduled" | "after-hours";

export function nextLearnEntry(
  prev: NoteLearnEntry | undefined,
  sample: string,
  decision: NoteDecision,
  now: string,
): NoteLearnEntry | null {
  if (prev?.state) return null;
  if (decision === "after-hours") return null;
  const approved = decision === "approved";
  return {
    ok: approved ? (prev?.ok ?? 0) + 1 : 0,
    sched: (prev?.sched ?? 0) + (approved ? 0 : 1),
    sample: prev?.sample || sample,
    last: now,
  };
}

/**
 * Record what a supervisor just decided about a job's notes.
 *
 * `approved` credits each sentence one consecutive approval. Otherwise the
 * sentence was answered with a time, which zeroes the run and records the
 * reschedule.
 */
export async function recordNoteDecision(
  notes: { norm: string; sample: string }[],
  approved: boolean,
  at: Date = new Date(),
): Promise<void> {
  const redis = getRedis();
  if (!redis || notes.length === 0) return;
  // A decision taken after the cutoff is about the HOUR, not the sentence: at
  // 8pm the shifts have ended, so "Hẹn giờ" means "not tonight" and says nothing
  // about whether the words are safe. Letting it zero the run would keep exactly
  // the sentences that appear on evening bookings from ever being proposed. The
  // report excludes evening for the same reason; the two now agree, and they are
  // ignored SYMMETRICALLY — an evening approval does not count either, so the
  // tally cannot be nudged upward by the hour it is unwilling to be nudged down by.
  const decision: NoteDecision = !isNoteReleaseHour(at)
    ? "after-hours"
    : approved
      ? "approved"
      : "rescheduled";

  const map = await readNoteLearning();
  const fields: Record<string, string> = {};
  const now = vnTimestamp(at);
  for (const { norm, sample } of notes) {
    if (!norm) continue;
    const next = nextLearnEntry(map[norm], sample, decision, now);
    if (next) fields[norm] = JSON.stringify(next);
  }
  if (Object.keys(fields).length === 0) return;
  await redis.hset(NOTE_LEARN_KEY, fields).catch(() => {});
}

/** Accept a proposed sentence onto the safe list, or dismiss it for good. */
export async function setNoteDecisionState(
  norm: string,
  state: "accepted" | "dismissed",
): Promise<boolean> {
  const redis = getRedis();
  if (!redis || !norm) return false;
  const map = await readNoteLearning();
  const prev = map[norm];
  if (!prev) return false;
  await redis.hset(NOTE_LEARN_KEY, { [norm]: JSON.stringify({ ...prev, state }) });
  invalidateAcceptedNotes();
  return true;
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
  /** When this pair was booked, epoch ms. Lets a reader ask the one question that
   *  decides whether a live Cartrack re-check is needed: has the published day been
   *  rebuilt SINCE this trip was made? If it has, the day already judged this pair and
   *  no fetch is required. Absent on entries written before this field existed, which
   *  read as "unknown" and fall back to the live check. */
  at?: number;
}

const pscPairRedisKey = (dateVn: string, pairKey: string) => `${PSC_PAIR_PREFIX}${dateVn}:${pairKey}`;

/** Record a just-booked pickup→dropoff so the guard sees it before the next publish. */
/**
 * Who a just-booked trip went to, for the branch that booked it.
 *
 * The branch's own screen shows a trip it made seconds ago from its device, not from
 * the published day — the day is rebuilt on a cycle and will not carry that trip for
 * minutes. So an assignment made seconds after booking was invisible to the one person
 * who most needed to see it, and the feature read as "no driver was assigned".
 *
 * A note here costs one small write and one read, against the alternative of the branch
 * polling Cartrack for a job it already knows the id of. Short-lived on purpose: it
 * answers "who just got this", and once the day carries the trip the feed is the truth.
 */
const INSTANT_ASSIGN_TTL_SEC = 15 * 60;
const instantAssignKey = (jobId: number) => `psc:assigned:${jobId}`;

export async function setInstantAssign(
  jobId: number, who: { driver_id: string; driver_name: string },
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(instantAssignKey(jobId), JSON.stringify(who), { ex: INSTANT_ASSIGN_TTL_SEC });
  } catch { /* best-effort: the feed still shows the driver once the day rebuilds */ }
}

export async function getInstantAssign(
  jobId: number,
): Promise<{ driver_id: string; driver_name: string } | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get<string | { driver_id: string; driver_name: string }>(instantAssignKey(jobId));
    if (!raw) return null;
    const who = typeof raw === "string" ? JSON.parse(raw) : raw;
    return who?.driver_id ? who : null;
  } catch {
    return null;
  }
}

export async function markPscPair(dateVn: string, pairKey: string, hit: PscDupHit): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    const stamped: PscDupHit = { ...hit, at: hit.at ?? Date.now() };
    await redis.set(pscPairRedisKey(dateVn, pairKey), JSON.stringify(stamped), { ex: PSC_PAIR_TTL_SEC });
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

/** Once-a-day housekeeping: trim the run log and refresh the TTLs that are no
 *  longer refreshed per-cycle.
 *
 *  Both chores exist because their per-cycle versions were pure overhead — an LTRIM
 *  of a 500-entry list every 3 minutes, and an EXPIRE re-set on a key whose lifetime
 *  is measured in days.
 *
 *  NO CLAIM OF ITS OWN, deliberately. An earlier draft gated this with its own
 *  `SET NX` and thereby gave back half of what it saved: a claim is a write, so
 *  asking "am I first today?" once per cycle costs 660 writes a day — the exact
 *  pattern this whole pass exists to remove. The caller already holds that answer
 *  (claimMorningPass), so it is passed in rather than re-purchased.
 *
 *  Runs at the START of the morning cycle, before the day's entries are pushed. That
 *  ordering is intentional and harmless: the trim cuts yesterday's tail, and today's
 *  entries accumulate on top of a freshly cut list.
 *
 *  Best-effort throughout: this is hygiene. A failed pass leaves a slightly longer
 *  list and a TTL that is still 48h from its last refresh, and tomorrow's first
 *  cycle tries again. */
export async function runDailyMaintenance(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.ltrim(RUN_LOG_KEY, 0, DAILY_LOG_KEEP - 1);
    await redis.expire(RUN_LOG_KEY, DAILY_TTL_S);
    await redis.expire(CYCLE_SNAPSHOT_KEY, DAILY_TTL_S);
  } catch (e) {
    console.error("[daily-maint] failed:", e instanceof Error ? e.message : e);
  }
}

/** Keyed by env so a manual UAT cycle can't consume prod's daily slot. */
const rolloverKey = (env: string, dateVn: string) => `assign:rollover_morning:${env}:${dateVn}`;

// ── Is the morning pass still worth asking about? ──────────────────────────
//
// The claim below is a WRITE, so asking "has the morning pass run yet?" costs a
// command on every cycle that asks — ~660 a day to hear "yes, hours ago" ~658
// times. Read the COMMAND BUDGET note at the top of this file: that is ~20k a
// month spent on one fact that stops changing before breakfast.
//
// So the question only reaches Redis while the answer could still be no:
//
//   * before MORNING_CLAIM_WINDOW_END_MIN — the window the pass belongs to, wide
//     enough that deferMorningPass's ten-minute retries all land inside it;
//   * after it, ONCE per instance per day. That second clause is what keeps a
//     late recovery alive: if the pings were down or the engine sat disarmed all
//     morning, the first cycle on any fresh lambda still asks, still claims the
//     slot, and still rolls yesterday's leftovers in at 11:00 rather than losing
//     the day. A per-instance flag is safe here precisely BECAUSE it is
//     per-instance — it can suppress a repeat question from the same lambda,
//     never the first one from a new one.
const MORNING_CLAIM_WINDOW_END_MIN = 9 * 60; // 09:00 VN

// How long a morning-pass claim is held before it lapses of its own accord.
// Long enough that concurrent cycles (two accounts, ~90s apart) cannot both
// take the pass, short enough that a timeout-killed pass is retried within the
// pre-09:00 window where every cycle still asks. See claimMorningPass.
const MORNING_LEASE_S = 900; // 15 minutes

let morningClaimAskedOn: string | null = null;

/** Whether to spend a command asking Redis for the day's morning-pass slot.
 *  Pure so `scripts/morning-claim-gate.test.mts` can pin it without a stub. */
export function morningClaimIsDue(
  dateVn: string,
  lastAskedOn: string | null,
  minsSinceMidnight: number,
): boolean {
  if (minsSinceMidnight < MORNING_CLAIM_WINDOW_END_MIN) return true;
  return lastAskedOn !== dateVn;
}

/** True for the FIRST armed cycle of the VN day, false for every cycle after it.
 *
 *  ONE claim, TWO morning chores — the rollover of yesterday's unfinished jobs into
 *  today's window, and the full no-date REST sweep of the proxy driver's parked jobs.
 *  They used to hold separate gates, which was two ways of writing down one fact
 *  ("nobody has done the morning pass yet"). The sweep's own gate cost ~660 writes a
 *  day to succeed 48 times, because a claim is a WRITE whether or not it claims
 *  anything.
 *
 *  Once a day is the right cadence for the sweep, not a budget compromise: jobs parked
 *  for TODAY sit on the proxy driver's today-timeline and are released by any ordinary
 *  cycle when they come due (and by the REST fallback when the timeline call fails).
 *  The only thing the no-date sweep finds that nothing else can is a job whose release
 *  time has passed but whose scheduled date is NOT today — stranded from an earlier
 *  day. Those are no more urgent at 14:30 than at 05:30.
 *
 *  Without Redis, returns true every cycle: the rollover is harmless to repeat (after
 *  the first pass yesterday's status-2 window is empty) and the sweep degrades to its
 *  pre-timeline every-cycle behaviour. Fail-safe, never fail-silent. */
export async function claimMorningPass(dateVn: string, env = "prod"): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;

  const mins = vnMinutesSinceMidnight();
  if (!morningClaimIsDue(dateVn, morningClaimAskedOn, mins)) return false;
  // Recorded only OUTSIDE the window, so an instance that asked at 08:00 still
  // gets its one post-window ask — the retry slot an 08:55 defer would need.
  if (mins >= MORNING_CLAIM_WINDOW_END_MIN) morningClaimAskedOn = dateVn;

  // Claimed for MINUTES, not the day. The morning pass runs inside a 60s
  // function; when it overruns, Vercel KILLS the process — that is not a thrown
  // error, so `deferMorningPass` in the caller's failure branch never executes
  // and a full-day claim would sit there until tomorrow with the work half done
  // and its logs discarded. That is exactly what happened on 2026-08-30
  // (claimed 05:30:44, "candidates: 83" at 05:30:48, killed at 60s) and, on the
  // evidence, several mornings before it.
  //
  // So the claim is only a short lease: a killed pass lets it lapse and the next
  // cycle picks the work up. Nothing has to run after the failure for the retry
  // to happen, which is the whole point — a kill leaves no opportunity to run
  // anything. `confirmMorningPass` promotes the lease to the full day once the
  // pass has actually finished. Re-running after a completed-but-unconfirmed
  // pass is harmless: rolled jobs now carry today's date, so yesterday's window
  // is empty and the second pass rolls nothing.
  const res = await redis.set(rolloverKey(env, dateVn), new Date().toISOString(), { nx: true, ex: MORNING_LEASE_S });
  return res === "OK";
}

/** Promote the short claim lease to the rest of the day — call ONLY once the
 *  morning pass has completed. Until this runs the lease expires on its own,
 *  which is what makes a timeout-killed pass retry instead of vanishing. */
export async function confirmMorningPass(dateVn: string, env = "prod"): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(rolloverKey(env, dateVn), new Date().toISOString(), { ex: 172_800 }).catch(() => {});
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
export async function deferMorningPass(dateVn: string, env = "prod", retrySec = 600): Promise<void> {
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
  "NO DROPOFF RULE",          // branch configured, but no row for this destination
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

/** Append a cycle's important log entries to the rolling live-log list.
 *
 *  ONE command. The trim and the TTL refresh that used to ride along on every
 *  cycle now happen once a day in runDailyMaintenance() — an LTRIM every 3 minutes
 *  was tidying a shelf nobody had disturbed, and re-setting a 24h expiry 660 times
 *  a day is 660 commands to express a fact that changes once. Between trims the
 *  list runs a day long instead of capped at 500; readers take the newest 100 off
 *  the head, so that costs them nothing. */
export async function pushRunLog(logs: LogEntry[]): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const kept = logs.filter(shouldStore);
  if (kept.length === 0) return;
  // lpush in chronological order ⇒ newest entry ends up at the head.
  // `pushed` is an in-process marker (see the early flush in assign.ts); it must
  // not be stored, or the dashboard reads a field that means nothing to it.
  await redis.lpush(RUN_LOG_KEY, ...kept.map(({ pushed: _p, ...entry }) => JSON.stringify(entry)));
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
  /** Spreadsheet tabs the engine is currently refusing to read. */
  sheetAlarms: SheetAlarm[];
  /** Config lines naming a branch but no driver — the to-do list. */
  unfinished: UnfinishedConfigRow[];
  /** Hours a job needed and no rule covered. */
  gaps: CoverageGap[];
  /** When the sheet behind both lists was last read. */
  parsedAt: string;
  /** The rules each listed branch already has. */
  branchRules: Record<string, BranchRule[]>;
}

/** One pipeline request to Upstash — and, since held/failed/warnings moved into a
 *  single hash, FOUR commands per poll instead of six. The dashboard polls every
 *  90s per open tab, so each command removed here is ~24k a month. */
export async function getStatusBundle(logLimit = 100): Promise<StatusBundle> {
  const redis = getRedis();
  if (!redis) return { state: null, lastChecked: null, deployments: [], logs: [], held: [], warnings: [], failed: [], sheetAlarms: [], unfinished: [], gaps: [], parsedAt: "", branchRules: {} };

  const pipe = redis.pipeline();
  pipe.get(ARM_KEY);
  pipe.lrange(RUN_LOG_KEY, 0, logLimit - 1);
  pipe.hgetall(CYCLE_SNAPSHOT_KEY);
  pipe.hgetall(DEPLOY_HEARTBEAT_KEY);
  const [rawState, rawLogs, rawSnapshot, rawDeployments] = await pipe.exec();

  const state = parseMaybe<ArmState>(rawState as string | ArmState | null);
  const validState = state && Date.now() < state.armedUntil ? state : null;

  // Derived from the per-deployment hash rather than its own key — one less
  // command per poll, and the two can no longer disagree.
  const deployments = parseDeploymentBeats(rawDeployments);
  const lastChecked = newestBeat(deployments);

  const logEntries = ((rawLogs as (string | LogEntry)[]) ?? [])
    .map((r) => (typeof r === "string" ? JSON.parse(r) : r) as LogEntry)
    .reverse();

  const snap = (rawSnapshot ?? {}) as Record<string, unknown>;
  const held = parseList<HeldJob>(snap[F_HELD]);
  const failed = parseList<FailedJob>(snap[F_FAILED]);
  const sheetAlarms = parseList<SheetAlarm>(snap[F_SHEET_ALARMS]);
  const unfinished = parseList<UnfinishedConfigRow>(snap[F_UNFINISHED]);
  const gaps = parseList<CoverageGap>(snap[F_GAPS]);
  const parsedAt = typeof snap[F_PARSED_AT] === "string" ? (snap[F_PARSED_AT] as string) : "";
  const branchRules = (() => { try { const v = snap[F_BRANCH_RULES]; return v ? (typeof v === "string" ? JSON.parse(v) : v) : {}; } catch { return {}; } })() as Record<string, BranchRule[]>;

  // Warnings expire in the READER now, not in Redis. The old 10-minute TTL existed
  // so a disarmed engine's warnings stopped being shown as current; merging keys
  // meant that guarantee had to move here rather than be quietly dropped.
  const warningsAt = Number(snap[F_WARNINGS_TS] ?? 0);
  const warnings = warningsAt && Date.now() - warningsAt < WARNINGS_MAX_AGE_MS
    ? parseList<PickupWarning>(snap[F_WARNINGS])
    : [];

  return {
    state: validState,
    lastChecked,
    deployments,
    logs: logEntries,
    held,
    warnings,
    failed,
    sheetAlarms,
    unfinished,
    gaps,
    parsedAt,
    branchRules,
  };
}

/**
 * The bundle as the dashboard receives it.
 *
 * Lives here, beside the bundle, and SPREADS rather than re-listing fields. Three
 * separate fields have been computed by getStatusBundle and then dropped on the
 * way out of the status route: sheetAlarms, so the refused-tab banner never once
 * appeared; then branchRules and parsedAt, which left every config editor opening
 * with none of the branch's existing shifts in it — so a shift could be replaced
 * but never extended. The defect is invisible at the call site: the field is
 * fetched, typed, correct, and simply not named again. Spreading takes away the
 * chance to forget.
 */
export function statusPayload(bundle: StatusBundle, since: string | null) {
  return {
    ...bundle,
    armed: !!bundle.state,
    logs: since ? bundle.logs.filter((l) => l.ts >= since) : bundle.logs,
  };
}

// ── Config rows written for unconfigured branches ────────────────────────────
//
// One row per branch, once — across every instance and both deployments. The
// claim has to be shared, because two servers hitting the same unconfigured
// pickup in the same minute would otherwise each append a line.
//
// Asked at most once per branch per instance. The naive version — claim on every
// cycle — would ask ~660 times a day for a branch that stays unconfigured until
// someone fills it in, which is exactly the once-per-interval-asked-every-cycle
// waste this file has had to unpick before. A local memo of the answer costs
// nothing and makes a cold start the only thing that re-asks.
const writtenBranches = new Set<string>();
const UNMAPPED_TTL_S = 30 * 24 * 60 * 60;

/**
 * True when THIS caller should write the config row for `customerId`.
 *
 * False when someone already has, and false when Redis is unreachable — the
 * cautious direction on purpose: skipping a row costs a supervisor one manual
 * entry, while writing a duplicate puts a second half-finished line into the
 * table that drives every assignment.
 */
export async function claimUnmappedConfigRow(customerId: string): Promise<boolean> {
  if (!customerId || writtenBranches.has(customerId)) return false;
  const redis = getRedis();
  if (!redis) return false;
  try {
    const res = await redis.set(`config:unmapped_written:${customerId}`, vnTimestamp(), {
      nx: true, ex: UNMAPPED_TTL_S,
    });
    // Remembered either way: won or lost, this instance has its answer and never
    // needs to ask again for this branch.
    writtenBranches.add(customerId);
    return res === "OK";
  } catch {
    return false;
  }
}

/**
 * Serialise config-sheet writes across instances.
 *
 * Allocating a row is read-then-write: two servers that both look at the same
 * moment both see the same first free row and the second silently overwrites the
 * first, losing a line whose branch is already marked as written and therefore
 * never retried. Rare — new branches arrive a few times a week — but silent, and
 * this is the table every assignment reads.
 *
 * Short TTL: the write it guards is two API calls. If a server dies mid-write the
 * lock clears itself well before the next cycle.
 */
export async function acquireConfigWriteLock(): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    return (await redis.set("config:write_lock", vnTimestamp(), { nx: true, ex: 60 })) === "OK";
  } catch {
    return false;
  }
}

export async function releaseConfigWriteLock(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try { await redis.del("config:write_lock"); } catch { /* expires on its own */ }
}

// ── Hours a branch was configured for but nobody was on ──────────────────────
//
// Recorded when a job falls into one, because unlike an unconfigured branch
// there is no ROW to write: the fix is stretching a rule that already exists, so
// the sheet cannot hold the record and something else must.
//
// Written once per gap per instance — a new one is a rare event, not a per-cycle
// occurrence. CLEARING is not done from here: the config parse decides, by
// checking whether the branch now covers that minute. That direction matters.
// An alarm that can only be retracted by whoever raised it becomes immortal the
// moment that instance goes away — which is exactly what left a wrong banner
// standing all morning on 2026-08-31.
const GAPS_KEY = "config:gaps";
const seenGaps = new Set<string>();

const gapField = (customerId: string, at: string) => `${customerId}|${at}`;

/**
 * Record an hour that had no cover. Idempotent, and asked at most once per
 * instance per gap.
 *
 * Returns whether this was a hole nobody had recorded yet — HSET counts only the
 * fields it ADDS, so a re-record of the same branch-and-minute answers 0 however
 * many instances try it. That answer is what tells the cycle to refresh the
 * config: the panel's list is built during the sheet parse, which happens once a
 * day, so a gap found at 07:03 would otherwise sit in this hash unseen until
 * tomorrow morning's parse. Only a genuinely new one is worth a re-parse.
 */
export async function recordCoverageGap(
  customerId: string, pickupName: string, at: string, dropoffName = "",
): Promise<boolean> {
  const field = gapField(customerId, at);
  if (!customerId || !at || seenGaps.has(field)) return false;
  const redis = getRedis();
  if (!redis) return false;
  try {
    // The destination rides along in the SAME field — context for the panel, not
    // a second record. The key stays branch-and-minute, so a branch shipping to
    // two places at that minute is still one hole and still one HSET.
    const added = await redis.hset(GAPS_KEY, { [field]: JSON.stringify({ customer_id: customerId, pickup_name: pickupName, dropoff_name: dropoffName, at }) });
    // Marked seen only once it is actually stored, so a Redis blip retries next
    // cycle instead of losing the gap for the life of this instance.
    seenGaps.add(field);
    return added > 0;
  } catch {
    return false; // best-effort: the job has already been reported as failing
  }
}

export interface RecordedGap {
  customer_id: string;
  pickup_name: string;
  at: string;
  /** Absent on anything written before this field existed. */
  dropoff_name?: string;
}

/** Everything recorded so far. One command. */
export async function readCoverageGaps(): Promise<RecordedGap[]> {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const all = await redis.hgetall<Record<string, string>>(GAPS_KEY);
    if (!all) return [];
    return Object.values(all).map((v) => (typeof v === "string" ? JSON.parse(v) : v)).filter(Boolean);
  } catch {
    return [];
  }
}

/** Drop the ones the config now covers. Called by the parse, which is the only
 *  thing that knows. */
export async function clearCoverageGaps(fields: { customer_id: string; at: string }[]): Promise<void> {
  if (fields.length === 0) return;
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.hdel(GAPS_KEY, ...fields.map((f) => gapField(f.customer_id, f.at)));
    for (const f of fields) seenGaps.delete(gapField(f.customer_id, f.at));
  } catch { /* it will be retried on the next parse */ }
}
