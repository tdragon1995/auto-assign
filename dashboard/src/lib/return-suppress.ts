import { Redis } from "@upstash/redis";
import { vnDate } from "./time";

/**
 * Memory of return trips the cleanup pass already rejected today.
 *
 * Why this exists: a completed outbound stays status 5 for the WHOLE day, so it
 * keeps re-triggering the return-trip creator every cycle. The creator's own
 * guards only see returns that are still live (status 2/4) or completed (5) — a
 * return that cleanup rejected off-shift is status 3/7 and therefore invisible.
 * So when a driver's shift window re-opened later the same day, the engine
 * happily re-created the return it had just cleaned up.
 *
 * We record the rejected return's `create_ts` against its `from:to:driver` key.
 * The creator then treats it exactly like a completed return: "a return for this
 * route was already made AFTER this outbound finished → don't make another."
 * A genuinely NEW outbound later that day finishes after that timestamp, so it
 * still earns its own return — only the already-handled one stays suppressed.
 */

// Hash per VN day: field = "fromId:toId:driverId", value = rejected return's create_ts.
const KEY_PREFIX = "ret:cleaned:v1:";
const TTL_SEC = 2 * 24 * 3600; // survives past midnight; the day key rotates anyway

// Warm-lambda mirror so suppression still holds for the rest of an instance's
// life if Redis is unconfigured or momentarily unreachable.
const localMirror = new Map<string, Map<string, string>>(); // dayKey → (returnKey → create_ts)

function getRedis() {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function dayKey(dateVn: string): string {
  return `${KEY_PREFIX}${dateVn}`;
}

function mirrorFor(dateVn: string): Map<string, string> {
  let m = localMirror.get(dateVn);
  if (!m) {
    m = new Map();
    localMirror.set(dateVn, m);
    // Drop stale days so a long-lived instance doesn't accumulate them.
    for (const k of localMirror.keys()) if (k !== dateVn) localMirror.delete(k);
  }
  return m;
}

/** Record returns that were just rejected, so today's creator won't remake them.
 *  Keeps the LATEST create_ts per route — a second, later return supersedes the first. */
export async function recordCleanedReturns(
  entries: Array<{ returnKey: string; createTs: string }>,
): Promise<void> {
  if (entries.length === 0) return;
  const today = vnDate();
  const mirror = mirrorFor(today);
  const fields: Record<string, string> = {};
  for (const { returnKey, createTs } of entries) {
    if (!returnKey || !createTs) continue;
    const prev = mirror.get(returnKey);
    if (!prev || createTs > prev) mirror.set(returnKey, createTs);
    const staged = fields[returnKey];
    if (!staged || createTs > staged) fields[returnKey] = createTs;
  }
  if (Object.keys(fields).length === 0) return;

  const redis = getRedis();
  if (!redis) return; // mirror-only; best effort
  const key = dayKey(today);
  await redis.hset(key, fields);
  await redis.expire(key, TTL_SEC);
}

/** Today's suppressed routes: "fromId:toId:driverId" → rejected return's create_ts.
 *  Never throws — on any failure we fall back to the warm-instance mirror. */
export async function loadCleanedReturns(): Promise<Map<string, string>> {
  const today = vnDate();
  const out = new Map(mirrorFor(today));
  const redis = getRedis();
  if (!redis) return out;
  try {
    const hash = await redis.hgetall<Record<string, string>>(dayKey(today));
    for (const [k, v] of Object.entries(hash ?? {})) {
      const prev = out.get(k);
      if (typeof v === "string" && (!prev || v > prev)) out.set(k, v);
    }
  } catch {
    // Redis hiccup — mirror is the fallback.
  }
  return out;
}
