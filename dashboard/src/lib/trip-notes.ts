import type { Redis } from "@upstash/redis";
import { sharedRedis } from "@/lib/redis";
import { getJobsDetailsFast, type Env } from "@/lib/cartrack";
import { notesOf, type NoteMap, type StopNotes } from "@/lib/stop-notes";

/**
 * The driver's TYPED note on each trip — todo_type_id 5, "Note @ pickup" / "Note @
 * dropoff", which is where "Bảo 2 ống đỏ" / "Trúc 2 ống đỏ" is recorded — and every
 * photo on it, for the trips a branch's feed is showing. Nothing the feed holds carries
 * a todo: the route timeline the day snapshot is built from has none.
 *
 * PER TRIP, FROZEN ONCE FINISHED. This used to download the whole network day (REST list,
 * ~10 MB, two pages on a busy day) every 5 minutes to answer for a few dozen trips. Now it
 * asks Cartrack's job RPC for exactly the ids named, in batches, and keeps each trip's
 * answer in one hash field. A finished trip (done / rejected / cancelled) can gain no new
 * note or photo, so it is never asked again that day; only trips still on the road are
 * re-asked, and not more often than STALE_MS. Slower on a cold day, by design — the lab's
 * ~450 trips cost ~9 batches once, then only the unfinished handful.
 *
 * Two readers: the branch feed (/api/location-jobs) hands back whatever is SAVED with the
 * trip list, so most page opens make one request; /api/location-notes then asks Cartrack
 * for only the trips that came back missing or stale.
 *
 * Failure is always an empty map: a missing note must never take the feed down with it.
 */

/** A trip still on the road is re-asked at most this often — the same 3 minutes the
 *  trip list itself runs behind (the cron's publish interval). */
const STALE_MS = 180_000;
/** The day's hash outlives the day: a past date is still opened the next morning. */
const KEY_TTL_S = 36 * 3600;
/** delivery_get_job_details ids per call (10 ids ≈ 230 KB, ~0.1 s, measured). */
const BATCH = 50;
/** Hard cap on RPC calls per request — bisecting a dead Cartrack must not become 100 calls. */
const MAX_CALLS = 40;
/** done / rejected / cancelled: nothing more can be written on the trip. */
const FINAL_STATUS = new Set([3, 5, 7]);

/** D001 receives ~450 trips a day; this only bounds a hand-made URL. */
export const MAX_NOTE_IDS = 1000;

interface Entry { n: StopNotes | null; f: boolean; at: number }

function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return sharedRedis();
}

/** Ask Cartrack for `ids`, bisecting a failed batch: one deleted or foreign id fails the
 *  WHOLE call, so halving isolates it and the rest still get answered. */
async function fetchEntries(env: Env, ids: number[], budget: { calls: number }): Promise<Record<string, Entry>> {
  const out: Record<string, Entry> = {};
  const now = Date.now();
  const ask = async (chunk: number[]): Promise<void> => {
    if (!chunk.length || budget.calls <= 0) return;
    budget.calls--;
    const jobs = await getJobsDetailsFast(chunk, env).catch(() => null);
    if (jobs) {
      for (const j of jobs) {
        out[String(j.job_id)] = { n: notesOf(j), f: FINAL_STATUS.has(Number(j.job_status_id)), at: now };
      }
      return;
    }
    if (chunk.length === 1) return; // that id is gone or not ours — left out, asked again later
    const mid = chunk.length >> 1;
    await ask(chunk.slice(0, mid));
    await ask(chunk.slice(mid));
  };
  // ponytail: batches run one after another — slower, but a cold lab day is ~9 calls once.
  for (let i = 0; i < ids.length; i += BATCH) await ask(ids.slice(i, i + BATCH));
  return out;
}

const keyOf = (env: Env, date: string) => `stopnotes:v6:${env}:${date}`;

/** What is saved for `ids`, read in one HMGET. Redis is the saving, never the answer: an
 *  Upstash hiccup costs a fetch, not the notes. */
async function readEntries(redis: Redis | null, env: Env, date: string, ids: number[]): Promise<Record<string, Entry>> {
  const have: Record<string, Entry> = {};
  if (!redis || !ids.length) return have;
  try {
    const row = await redis.hmget<Record<string, Entry | null>>(keyOf(env, date), ...ids.map(String));
    for (const [id, e] of Object.entries(row ?? {})) if (e) have[id] = e;
  } catch (e) {
    console.error("[location-notes] cache read", e);
  }
  return have;
}

const needsAsking = (e: Entry | undefined, now: number) => !e || (!e.f && now - e.at > STALE_MS);

function toMap(ids: number[], have: Record<string, Entry>): NoteMap {
  const out: NoteMap = {};
  for (const id of ids) { const n = have[String(id)]?.n; if (n) out[id] = n; }
  return out;
}

/** The saved notes only — no Cartrack call — plus the ids whose answer is missing or
 *  stale, which the page then asks /api/location-notes for. */
export async function savedNotes(env: Env, date: string, ids: number[]): Promise<{ notes: NoteMap; missing: number[] }> {
  const have = await readEntries(getRedis(), env, date, ids.slice(0, MAX_NOTE_IDS));
  const now = Date.now();
  return { notes: toMap(ids, have), missing: ids.filter((id) => needsAsking(have[String(id)], now)) };
}

export async function notesFor(env: Env, date: string, ids: number[]): Promise<NoteMap> {
  const redis = getRedis();
  const key = keyOf(env, date);
  const have = await readEntries(redis, env, date, ids);

  const now = Date.now();
  const ask = ids.filter((id) => needsAsking(have[String(id)], now));
  if (ask.length) {
    const got = await fetchEntries(env, ask, { calls: MAX_CALLS });
    Object.assign(have, got);
    if (redis && Object.keys(got).length) {
      try {
        const p = redis.pipeline();
        p.hset(key, got);
        p.expire(key, KEY_TTL_S);
        await p.exec();
      } catch {}
    }
  }

  return toMap(ids, have);
}
