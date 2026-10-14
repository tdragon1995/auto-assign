import { NextRequest, NextResponse } from "next/server";
import type { Redis } from "@upstash/redis";
import { sharedRedis } from "@/lib/redis";
import { getJobsDetailsFast, type Env } from "@/lib/cartrack";
import { notesOf, type NoteMap, type StopNotes } from "@/lib/stop-notes";

export const preferredRegion = "sin1";

/**
 * GET /api/location-notes?date=YYYY-MM-DD&ids=<job_id>,<job_id>,…
 *
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
 * Failure is always an empty map: a missing note must never take the feed down with it.
 */

/** A trip still on the road is re-asked at most this often. */
const STALE_MS = 60_000;
/** The day's hash outlives the day: a past date is still opened the next morning. */
const KEY_TTL_S = 36 * 3600;
/** delivery_get_job_details ids per call (10 ids ≈ 230 KB, ~0.1 s, measured). */
const BATCH = 50;
/** Hard cap on RPC calls per request — bisecting a dead Cartrack must not become 100 calls. */
const MAX_CALLS = 40;
/** done / rejected / cancelled: nothing more can be written on the trip. */
const FINAL_STATUS = new Set([3, 5, 7]);

/** D001 receives ~450 trips a day; this only bounds a hand-made URL. */
const MAX_IDS = 1000;

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

async function notesFor(env: Env, date: string, ids: number[]): Promise<NoteMap> {
  const redis = getRedis();
  const key = `stopnotes:v5:${env}:${date}`;
  const have: Record<string, Entry> = {};

  // Redis is the saving, never the answer: an Upstash hiccup costs a fetch, not the notes.
  if (redis) {
    try {
      const row = await redis.hmget<Record<string, Entry | null>>(key, ...ids.map(String));
      for (const [id, e] of Object.entries(row ?? {})) if (e) have[id] = e;
    } catch (e) {
      console.error("[location-notes] cache read", e);
    }
  }

  const now = Date.now();
  const ask = ids.filter((id) => { const e = have[String(id)]; return !e || (!e.f && now - e.at > STALE_MS); });
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

  const out: NoteMap = {};
  for (const id of ids) { const n = have[String(id)]?.n; if (n) out[id] = n; }
  return out;
}

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const date = req.nextUrl.searchParams.get("date");
  const ids = (req.nextUrl.searchParams.get("ids") ?? "")
    .split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_IDS);

  if (!date || !ids.length) return NextResponse.json({ notes: {} });

  try {
    return NextResponse.json({ notes: await notesFor(env, date, ids) });
  } catch (e) {
    // Loud on the server, empty to the phone. A note that never arrives is invisible on
    // the card — without this line the only symptom of a broken fetch is a feed that
    // quietly stops explaining itself.
    console.error("[location-notes]", e);
    return NextResponse.json({ notes: {} });
  }
}
