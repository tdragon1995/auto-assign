/**
 * Smart re-check: the best driver NOW, not when the job was assigned.
 *
 * A smart job is ranked once, at the moment it is assigned, and then left alone.
 * Measured over 15–17/10: the typical smart job then sat 40–57 minutes before its
 * driver set off for it, and by then someone else is often nearer. So every cycle
 * re-ranks the engine's own smart picks whose driver has not set off yet, and moves
 * the job when the winner of the SAME ranking reaches the pickup at least
 * RECHECK_MIN_GAIN_MIN sooner than the driver holding it.
 *
 * Rules (supervisor, 2026-10-19):
 *  - Only jobs the ENGINE smart-assigned. Cartrack does not say who assigned a job,
 *    so the engine records each pick here; a job whose driver no longer matches the
 *    record was moved by a person and is never touched again.
 *  - Locked once any pickup is under way (en route, arrived, done).
 *  - Re-checked only after RECHECK_MIN_AGE_MIN with its driver, counted again after
 *    every move. No cap on the number of moves.
 *  - Both drivers are measured the way the first assignment measures them (from
 *    their reference stop), the holder with this job taken off their route —
 *    otherwise they are anchored on its own pickup and can never lose it.
 *  - The KQ/VT holder keeps the job: the ranking already puts them first.
 *
 * SMART_RECHECK: unset = log-only (says what it WOULD move, moves nothing),
 * "live" = moves, "off" = does nothing.
 */
import type { Job } from "./types";
import { sharedRedis } from "./redis";

export type RecheckMode = "off" | "log" | "live";

export function recheckMode(): RecheckMode {
  const v = (process.env.SMART_RECHECK ?? "").trim().toLowerCase();
  return v === "off" || v === "live" ? v : "log";
}

export const RECHECK_MIN_AGE_MIN = 10;
export const RECHECK_MIN_GAIN_MIN = 5;

/** Who the engine last gave the job to (`d`), and when (`t`, epoch ms). */
export interface SmartAssignRecord { d: string; t: number }

/** True when the engine may re-rank this assigned job now. */
export function isRecheckable(job: Job, rec: SmartAssignRecord | undefined, nowMs: number): boolean {
  if (!rec || rec.d !== job.delivery_driver_id) return false;
  if (nowMs - rec.t < RECHECK_MIN_AGE_MIN * 60_000) return false;
  const pickups = (job.stops ?? []).filter((s) => s.stop_type_id === 1);
  return pickups.length > 0 && pickups.every((s) => s.stop_status_id === 1);
}

/** Minutes gained by moving the job, or null when it stays where it is. */
export function moveGain(holderId: string, holderEta: number, winnerId: string, winnerEta: number): number | null {
  if (winnerId === holderId) return null;
  const gain = holderEta - winnerEta;
  return gain >= RECHECK_MIN_GAIN_MIN ? gain : null;
}

const recKey = (env: string, date: string) => `smart:recheck:${env}:${date}`;
const logKey = (env: string, date: string) => `smart:recheck:log:${env}:${date}`;
const REC_TTL_S = 2 * 86_400;
const LOG_TTL_S = 14 * 86_400;

/** Note that the engine (re)assigned `jobId` to `driverId`. Best-effort: a missed
 *  write only means the job is never re-checked, which is today's behaviour. */
export async function recordSmartAssign(env: string, date: string, jobId: number, driverId: string, nowMs = Date.now()): Promise<void> {
  const redis = sharedRedis();
  if (!redis) return;
  try {
    const key = recKey(env, date);
    // HSET answers how many fields were NEW; the expiry is set with the first only.
    const added = await redis.hset(key, { [String(jobId)]: JSON.stringify({ d: driverId, t: nowMs }) });
    if (added > 0) await redis.expire(key, REC_TTL_S);
  } catch { /* best-effort */ }
}

/** Every pick the engine recorded today. One command. */
export async function readSmartAssigns(env: string, date: string): Promise<Map<number, SmartAssignRecord>> {
  const out = new Map<number, SmartAssignRecord>();
  const redis = sharedRedis();
  if (!redis) return out;
  try {
    const all = await redis.hgetall<Record<string, unknown>>(recKey(env, date));
    for (const [id, raw] of Object.entries(all ?? {})) {
      // The SDK hands back JSON already parsed; a plain string is parsed here.
      const v = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<SmartAssignRecord> | null;
      if (v && typeof v.d === "string" && typeof v.t === "number") out.set(Number(id), { d: v.d, t: v.t });
    }
  } catch { /* unreadable → nothing is re-checked this cycle */ }
  return out;
}

/** Keep each would-move / move for 14 days, so the log-only stage can be reviewed
 *  after the rolling live log (one day) has moved on. */
export async function logRecheck(env: string, date: string, line: string): Promise<void> {
  const redis = sharedRedis();
  if (!redis) return;
  try {
    const key = logKey(env, date);
    if ((await redis.rpush(key, line)) === 1) await redis.expire(key, LOG_TTL_S);
  } catch { /* best-effort */ }
}
