/**
 * Writing a day of route legs into Supabase.
 *
 * Lives in lib/ rather than inside the route handler because two callers need it:
 * the cron endpoint (/api/tat/archive) and the driver report (/api/tat/me), which
 * queues a refresh in the background when today's rows have gone stale. Importing
 * it out of a route module would pull that route's segment config — runtime,
 * maxDuration, preferredRegion — into the importer's graph.
 */
import { Redis } from "@upstash/redis";
import { getTimelineRoutes, type Env } from "./cartrack";
import { buildDayLegs } from "./tat";
import { buildDayPay } from "./pay";
import { sbDelete, sbUpsert, supabaseConfigured, missingSupabaseEnv } from "./supabase-rest";
import { vnDate, addDays, vnHoursMinutes } from "./time";
import type { TimelineRoute } from "./types";

/** Stops two overlapping cron pings — or a ping racing the report endpoint's
 *  stale-refresh — from both fetching the day and both rewriting it. Sized above
 *  the endpoint's own maxDuration so a killed invocation cannot leave a second
 *  one writing into the gap. */
const LOCK_TTL_S = 90;

export interface ArchiveResult {
  ok: boolean;
  date?: string;
  legs?: number;
  measured?: number;
  graded?: number;
  longGaps?: number;
  /** Where the distance answers came from — cache vs billed API vs failed. */
  distances?: { pairs: number; cache: number; api: number; self: number; failed: number; noCoords: number };
  /** The part-time pay half of the same pass. `error` here is reported, never
   *  thrown: pay rides the leg archive and must never be able to fail it. */
  pay?: {
    jobs?: number;
    punches?: number;
    distances?: { pairs: number; cache: number; api: number; self: number; failed: number; noCoords: number };
    error?: string;
  };
  skipped?: string;
  error?: string;
}

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/**
 * The part-time pay rows for a day, written with the same upsert-then-delete
 * order and for the same reason as the legs above: a write that dies must leave
 * the previous copy of the day intact rather than an empty one.
 *
 * NEVER THROWS. It is called from inside archiveDay's own try, where an
 * exception would be caught as an archive failure — which releases the seal and
 * costs the day its legs as well as its pay. Pay is the newer, smaller record and
 * rides along; it does not get to fail the thing it is riding on.
 *
 * Punches are written even for a driver with no paid jobs. A day where somebody
 * clocked in and was never dispatched is still hours worked, and dropping it
 * because the job list came back empty would quietly stop paying for it.
 */
async function archivePay(
  routes: TimelineRoute[],
  date: string,
): Promise<NonNullable<ArchiveResult["pay"]>> {
  try {
    const { jobs, punches, stats } = await buildDayPay(routes, date);
    const stamp = new Date().toISOString();
    const staleOf = (d: string) => `trip_date=eq.${d}&archived_at=lt.${encodeURIComponent(stamp)}`;

    if (jobs.length > 0) {
      await sbUpsert(
        "pay_jobs",
        jobs.map((j) => ({ ...j, archived_at: stamp })) as unknown as Record<string, unknown>[],
        "trip_date,job_id",
      );
      await sbDelete("pay_jobs", staleOf(date));
    } else {
      await sbDelete("pay_jobs", `trip_date=eq.${date}`);
    }

    if (punches.length > 0) {
      await sbUpsert(
        "pay_punches",
        punches.map((p) => ({ ...p, archived_at: stamp })) as unknown as Record<string, unknown>[],
        "trip_date,job_id",
      );
      await sbDelete("pay_punches", staleOf(date));
    } else {
      await sbDelete("pay_punches", `trip_date=eq.${date}`);
    }

    return { jobs: jobs.length, punches: punches.length, distances: stats };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[tat-archive] pay archive failed:", msg);
    return { error: msg };
  }
}

/**
 * Fetch one day's routes, cut them into legs, price them, and replace that day in
 * tat_legs.
 *
 * WRITE ORDER IS THE WHOLE POINT: UPSERT FIRST, THEN DELETE WHAT WAS NOT TOUCHED.
 *
 * This used to delete the day and then insert it, which meant any failure between
 * the two — a 60-second timeout, a rejected column, a network blip — left the day
 * DELETED AND EMPTY. That is not theoretical: it happened three times in one
 * afternoon, once wiping seven consecutive days, and each time the day looked
 * simply "missing" rather than broken.
 *
 * Upserting first inverts the failure: if the write dies, nothing was removed and
 * yesterday's copy of the day survives untouched. The follow-up delete then clears
 * only rows this pass did not write — legs whose stop pairing changed, which is
 * what the old delete-first existed to handle. If THAT delete fails, the day keeps
 * a few stale legs: wrong in a small, visible, self-correcting way instead of
 * absent entirely.
 *
 * `archived_at` is stamped explicitly rather than left to its column default,
 * because on an upsert the default does not re-fire — and that stamp is exactly
 * what separates "written by this pass" from "left over from the last one".
 */
export async function archiveDay(date: string, env: Env = "prod"): Promise<ArchiveResult> {
  if (!supabaseConfigured()) {
    return { ok: false, date, error: "Supabase chưa được cấu hình (thiếu SUPABASE_SERVICE_ROLE_KEY)." };
  }

  const redis = getRedis();
  const lockKey = `tat:lock:${env}:${date}`;
  if (redis) {
    const got = await redis.set(lockKey, Date.now(), { nx: true, ex: LOCK_TTL_S }).catch(() => null);
    if (got !== "OK") return { ok: true, date, skipped: "another archive run holds the lock" };
  }

  try {
    const routes = await getTimelineRoutes(date, env);
    // null means the fleetweb login or the RPC failed. An empty day written over a
    // good one would erase it, so a failed fetch must never reach the delete.
    if (!routes) return { ok: false, date, error: "Không lấy được lộ trình từ Cartrack." };

    const { legs, stats } = await buildDayLegs(routes, date);

    const stamp = new Date().toISOString();
    if (legs.length > 0) {
      const rows = legs.map((l) => ({ ...l, archived_at: stamp }));
      await sbUpsert("tat_legs", rows as unknown as Record<string, unknown>[], "from_stop_id,to_stop_id");
      // Only now, once the day is safely written, clear what this pass did not
      // touch. Legs whose stop pairing changed since last time land here.
      await sbDelete("tat_legs", `trip_date=eq.${date}&archived_at=lt.${encodeURIComponent(stamp)}`);
    } else {
      // A genuinely empty day still has to clear whatever was there before.
      await sbDelete("tat_legs", `trip_date=eq.${date}`);
    }

    // The pay half of the same day, off the SAME routes — no second Cartrack
    // fetch, no second cron, no second seal. It runs AFTER the legs are safely
    // written and inside its own try/catch, because a pay failure must never cost
    // the day its TAT archive: legs are the older record and the one the seal was
    // built for, and a lost seal would take the day's legs with it.
    const pay = await archivePay(routes, date);

    return {
      ok: true,
      date,
      legs: legs.length,
      measured: legs.filter((l) => l.tat_mins != null).length,
      graded: legs.filter((l) => l.on_time != null).length,
      longGaps: legs.filter((l) => l.long_gap).length,
      distances: stats,
      pay,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[tat-archive] failed:", msg);
    return { ok: false, date, error: msg };
  } finally {
    if (redis) await redis.del(lockKey).catch(() => {});
  }
}

/** How many past days the once-a-day seal will reach back for. Bounded so a cold
 *  start (or a stretch where the cron was down) catches up over a few pings
 *  instead of firing a burst of day-fetches at Cartrack in one invocation. Longer
 *  gaps are a job for the manual `?days=N` backfill. */
export const TAT_LOOKBACK_DAYS = 3;

/** Marks a past day as archived. Held for a week — long enough that no ping
 *  re-seals a day, short enough that the keys expire on their own. */
const sealKey = (env: Env, date: string) => `tat:sealed:${env}:${date}`;
const SEAL_TTL_S = 7 * 24 * 60 * 60;

/** The daily window this pass is allowed to run in, VN local, inclusive-exclusive.
 *
 *  WHY A WINDOW AT ALL. The seal gate is a `SET … NX` per candidate day — a claim
 *  that doubles as the check, which is what makes it safe across instances but also
 *  makes every *ask* a billed WRITE. Three lookback days × ~680 pings a day = ~2,040
 *  writes to re-answer a question that changes once, and that single line was the
 *  largest write source in the whole system (measured 2026-08-18). Confining the ask
 *  to the window costs ~21 writes a day instead.
 *
 *  WHY 05:00–05:10 SPECIFICALLY, and why it is NOT midnight. The cron only pings
 *  during UTC 0–14 and 22–23, i.e. VN 05:00–21:59 — there is no such thing as an
 *  overnight ping here, and a midnight gate would silently never fire. VN 05:00 is
 *  the first ping of the day and lands in the UTC-22 block, before the 05:30
 *  auto-arm, so these pings return "disarmed" and this pass has the invocation to
 *  itself. Yesterday is genuinely finished by then. (Older comments in this file say
 *  "overnight disarmed pings" — this window is what they mean.)
 *
 *  Ten minutes is ~7 pings across both cron schedules, and the pass seals at most
 *  one day per call, so a three-day backlog still clears in a single morning. */
const SEAL_WINDOW_START_MIN = 5 * 60;      // 05:00 VN
const SEAL_WINDOW_END_MIN = 5 * 60 + 10;   // 05:10 VN

function insideSealWindow(d = new Date()): boolean {
  const { hours, minutes } = vnHoursMinutes(d);
  const mins = hours * 60 + minutes;
  return mins >= SEAL_WINDOW_START_MIN && mins < SEAL_WINDOW_END_MIN;
}

/**
 * Seal one finished day, at most once ever, and at most one day per call.
 *
 * WHY THIS HANGS OFF THE ASSIGN CRON
 *   A day only stops changing once it is over, so the natural trigger is the
 *   first ping after midnight — and the assign cron is already pinging. Adding a
 *   second external schedule would mean a second thing to configure, a second
 *   thing to forget, and a second single point of failure, when the one we have
 *   already fires every few minutes.
 *
 *   Overnight is also the cheapest moment to spend: the engine is disarmed
 *   between 22:00 and 05:30, so those pings return immediately and this runs with
 *   the invocation to itself rather than competing with a cycle.
 *
 * TODAY IS NOT THIS FUNCTION'S JOB. Today is still moving, and /api/tat/me
 * refreshes it on demand when a driver looks. This seals what is finished.
 *
 * Self-healing: the loop walks OLDEST first, so a stretch of missed days fills in
 * order, one per ping. Claiming the seal before the work and releasing it on
 * failure means a failed day is retried on the next ping rather than silently
 * skipped forever.
 *
 * Never throws — the caller is the assign cron, where a reporting error must not
 * become an assignment error.
 */
export async function archiveSealedDays(
  env: Env = "prod",
  /** Injectable clock. Production never passes it; the tests must, because the
   *  window below means every assertion about what this pass DOES would otherwise
   *  only hold for ten minutes a day and pass vacuously the rest of the time. */
  now: Date = new Date(),
): Promise<ArchiveResult | null> {
  // Cheapest check first, and free: no Redis call at all outside the window. This is
  // the whole saving — see SEAL_WINDOW_START_MIN.
  if (!insideSealWindow(now)) return null;

  // Checked INSIDE the window, and reported rather than returned as a bare null.
  // This function has four separate reasons to do nothing — outside the window, no
  // Supabase, no Redis, everything already sealed — and a silent null for all of
  // them is indistinguishable in the logs from "working normally". Naming the
  // missing variable costs ~7 log lines a day at worst, only while broken.
  const missing = missingSupabaseEnv();
  if (missing.length > 0) {
    return { ok: false, error: `Supabase chưa được cấu hình — thiếu ${missing.join(", ")}.` };
  }

  const redis = getRedis();
  // Without Redis there is no way to remember what has been sealed, and an
  // ungated archive would re-run on every ping. Better to do nothing.
  if (!redis) return null;

  const today = vnDate(now);

  try {
    for (let back = TAT_LOOKBACK_DAYS; back >= 1; back--) {
      const date = addDays(today, -back);
      const claimed = await redis
        .set(sealKey(env, date), Date.now(), { nx: true, ex: SEAL_TTL_S })
        .catch(() => null);
      if (claimed !== "OK") continue; // already sealed (or Redis hiccup) — try the next day

      const res = await archiveDay(date, env);
      // Release the claim so the next ping retries. `skipped` means the day lock
      // was held by a concurrent run, which is also not a completed seal.
      if (!res.ok || res.skipped) await redis.del(sealKey(env, date)).catch(() => {});
      return res;
    }
  } catch (e) {
    console.error("[tat-archive] seal pass failed:", e instanceof Error ? e.message : e);
  }
  return null;
}
