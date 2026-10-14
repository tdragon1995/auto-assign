import { NextRequest, NextResponse } from "next/server";
import type { Redis } from "@upstash/redis";
import { sharedRedis } from "@/lib/redis";
import { getJobsByDate, type Env } from "@/lib/cartrack";
import { notesOf, type NoteMap, type StopNotes } from "@/lib/stop-notes";

export const preferredRegion = "sin1";

/**
 * GET /api/location-notes?date=YYYY-MM-DD&ids=<job_id>,<job_id>,…
 *
 * The driver's TYPED note on each trip — todo_type_id 5, "Note @ pickup" / "Note @
 * dropoff", which is where "Bảo 2 ống đỏ" / "Trúc 2 ống đỏ" is recorded — for the trips a
 * branch's feed is showing, so who handed what over is on the card rather than one tap and
 * a several-second detail fetch away.
 *
 * WHY THIS IS ITS OWN FETCH, and a whole-day one at that. Nothing the feed already holds
 * carries a todo:
 *   · the route timeline the day snapshot is built from has no todos field at all
 *     (checked against the live payload 2026-09-08: 80 routes, 1,189 stops, none), and
 *     the snapshot drops todos deliberately anyway — they were 111 KB of a day nobody
 *     rendered;
 *   · the per-job detail call does carry them and costs ~4.8s EACH, measured. The lab's
 *     54 client trips would be four minutes of Cartrack round-trips and 54 invocations.
 *   · the whole-day REST list carries every note in ONE ~6s call.
 * Cartrack ignores customer filters on that endpoint (verified — filter[customer_id]
 * returns all 772 jobs), so there is no narrower request to make.
 *
 * ONE MAP PER DAY, NOT PER BRANCH. This started as the lab's alone and cached per
 * location; opened to every branch, that shape would fetch the same 7 MB day once per
 * branch looking. The day is fetched once, reduced to the notes that exist (tens of KB),
 * and each caller is answered with just the ids it names — ids it got from its own feed,
 * so a note can never appear for a trip that feed does not show, and there is no
 * per-branch rule here to drift from the feed's.
 *
 * Failure is always an empty map: a missing note must never take the feed down with it.
 */

/** Same window the branch feed tolerates (FEED_MAX_AGE_MS). A note is written once, when
 *  the driver completes the stop, and never edited — so staleness only ever delays a new
 *  one by a few minutes. */
const CACHE_TTL_S = 300;

/** A branch's feed is a few dozen trips; this only bounds a hand-made URL. */
const MAX_IDS = 1000; // D001 receives ~450 trips a day

function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return sharedRedis();
}

// ponytail: no rebuild lock — branches that miss inside the same second each pay the day
// fetch. Feed loads follow attention rather than a timer, so they are staggered; add the
// day-snapshot's lock pattern if the logs ever show bursts of these.
async function notesFor(env: Env, date: string, ids: number[]): Promise<NoteMap | null> {
  const redis = getRedis();
  // v3: one hash field per trip (and the pickup photo on each entry), so a branch asking
  // about its few trips reads those fields — not the whole day's map, which the photo
  // links tripled. BUILT says the day was stored, so "no note" and "not cached" differ.
  const key = `stopnotes:v3:${env}:${date}`;
  const BUILT = "__built__";
  const pick = (all: Record<string, StopNotes | null | undefined>) => {
    const out: NoteMap = {};
    for (const id of ids) { const n = all[String(id)]; if (n) out[id] = n; }
    return out;
  };

  // Redis is the saving, never the answer: each side is guarded on its own so an Upstash
  // hiccup costs a fetch rather than the notes. (A local .env pointed at a redis stub that
  // was not running is exactly how this first returned an empty map with a green status.)
  if (redis) {
    try {
      const row = await redis.hmget<Record<string, StopNotes | null>>(key, BUILT, ...ids.map(String));
      if (row?.[BUILT]) return pick(row);
    } catch (e) {
      console.error("[location-notes] cache read", e);
    }
  }

  // Every page: a busy day passes Cartrack's 1,000-per-page cap (1,057 on 2026-10-14),
  // and reading only the first left ~5% of trips with no note and no photo.
  const jobs = await getJobsByDate(date, env).catch((e) => {
    console.error(`[location-notes] Cartrack day list for ${date}`, e);
    return null;
  });
  if (!jobs) return null;

  const fields: Record<string, StopNotes | string> = { [BUILT]: "1" };
  for (const j of jobs) {
    const n = notesOf(j);
    if (n) fields[String(j.job_id)] = n;
  }

  if (redis) {
    try {
      const p = redis.pipeline();
      p.del(key);
      p.hset(key, fields);
      p.expire(key, CACHE_TTL_S);
      await p.exec();
    } catch {}
  }
  return pick(fields as Record<string, StopNotes>);
}

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const date = req.nextUrl.searchParams.get("date");
  const ids = (req.nextUrl.searchParams.get("ids") ?? "")
    .split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_IDS);

  if (!date || !ids.length) return NextResponse.json({ notes: {} });

  try {
    return NextResponse.json({ notes: (await notesFor(env, date, ids)) ?? {} });
  } catch (e) {
    // Loud on the server, empty to the phone. A note that never arrives is invisible on
    // the card — without this line the only symptom of a broken fetch is a feed that
    // quietly stops explaining itself.
    console.error("[location-notes]", e);
    return NextResponse.json({ notes: {} });
  }
}
