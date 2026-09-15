import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { BASE_URL, getHeaders, type Env } from "@/lib/cartrack";
import { notesOf, type NoteMap } from "@/lib/stop-notes";
import type { Job } from "@/lib/types";

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
const MAX_IDS = 300;

function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// ponytail: no rebuild lock — branches that miss inside the same second each pay the day
// fetch. Feed loads follow attention rather than a timer, so they are staggered; add the
// day-snapshot's lock pattern if the logs ever show bursts of these.
async function dayNotes(env: Env, date: string): Promise<NoteMap | null> {
  const redis = getRedis();
  const key = `stopnotes:v2:${env}:${date}`;

  // Redis is the saving, never the answer: each side is guarded on its own so an Upstash
  // hiccup costs a fetch rather than the notes. (A local .env pointed at a redis stub that
  // was not running is exactly how this first returned an empty map with a green status.)
  if (redis) {
    try {
      const hit = await redis.get<NoteMap>(key);
      if (hit) return hit;
    } catch (e) {
      console.error("[location-notes] cache read", e);
    }
  }

  const res = await fetch(
    `${BASE_URL}/jobs?filter[scheduled_delivery_ts_from]=${date} 00:00:00&filter[scheduled_delivery_ts_to]=${date} 23:59:59&limit=1000`,
    { headers: getHeaders(env), cache: "no-store" }
  );
  if (!res.ok) {
    console.error(`[location-notes] Cartrack ${res.status} for ${date}`);
    return null;
  }
  const jobs: Job[] = (await res.json()).data ?? [];

  const notes: NoteMap = {};
  for (const j of jobs) {
    const n = notesOf(j);
    if (n) notes[j.job_id] = n;
  }

  if (redis) {
    try { await redis.set(key, notes, { ex: CACHE_TTL_S }); } catch {}
  }
  return notes;
}

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const date = req.nextUrl.searchParams.get("date");
  const ids = (req.nextUrl.searchParams.get("ids") ?? "")
    .split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_IDS);

  if (!date || !ids.length) return NextResponse.json({ notes: {} });

  try {
    const all = await dayNotes(env, date);
    if (!all) return NextResponse.json({ notes: {} });
    const notes: NoteMap = {};
    for (const id of ids) if (all[id]) notes[id] = all[id];
    return NextResponse.json({ notes });
  } catch (e) {
    // Loud on the server, empty to the phone. A note that never arrives is invisible on
    // the card — without this line the only symptom of a broken fetch is a feed that
    // quietly stops explaining itself.
    console.error("[location-notes]", e);
    return NextResponse.json({ notes: {} });
  }
}
