import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { BASE_URL, getHeaders, type Env } from "@/lib/cartrack";
import { isClientPickupJob, isLabWatchedClient, LAB_CUSTOMER_ID } from "@/lib/job-filters";
import { notesOf, type NoteMap } from "@/lib/stop-notes";
import type { Job } from "@/lib/types";

export const preferredRegion = "sin1";

/**
 * GET /api/location-notes?date=YYYY-MM-DD&code=<customer_uuid>
 *
 * The driver's TYPED note on each trip — todo_type_id 5, "Note @ pickup" / "Note @
 * dropoff", which is where "Bảo 2 ống đỏ" / "Trúc 2 ống đỏ" is recorded. The lab reads
 * its feed to know who handed what over, and that answer was one tap and a several-second
 * detail fetch away on every single card.
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
 * So this is that one call, its answer reduced to a few KB of notes and cached for every
 * viewer. Cartrack ignores customer filters on that endpoint (verified — filter
 * [customer_id] returns all 772 jobs), so there is no narrower request to make.
 *
 * Scoped to the LAB deliberately: every other branch has a dozen trips and no reason to
 * make anyone pay a day-sized fetch for them. Failure is always an empty map — a missing
 * note must never be able to take the feed down with it.
 */

/** Same window the branch feed tolerates (FEED_MAX_AGE_MS). A note is written once, when
 *  the driver completes the stop, and never edited — so staleness only ever delays a new
 *  one by a few minutes. */
const CACHE_TTL_S = 300;

function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const date = req.nextUrl.searchParams.get("date");
  const code = req.nextUrl.searchParams.get("code");

  // Not the lab, or no date: nothing to say, and nothing fetched.
  if (!date || code !== LAB_CUSTOMER_ID) return NextResponse.json({ notes: {} });

  const redis = getRedis();
  const key = `stopnotes:v1:${env}:${date}:${code}`;

  // Redis is the saving, never the answer: each side is guarded on its own so an Upstash
  // hiccup costs a fetch rather than the notes. (It also costs nothing to get right — a
  // local .env pointed at a redis stub that is not running was exactly how this first
  // returned an empty map with a green status code.)
  if (redis) {
    try {
      const hit = await redis.get<NoteMap>(key);
      if (hit) return NextResponse.json({ notes: hit, cached: true });
    } catch (e) {
      console.error("[location-notes] cache read", e);
    }
  }

  try {

    const res = await fetch(
      `${BASE_URL}/jobs?filter[scheduled_delivery_ts_from]=${date} 00:00:00&filter[scheduled_delivery_ts_to]=${date} 23:59:59&limit=1000`,
      { headers: getHeaders(env), cache: "no-store" }
    );
    if (!res.ok) {
      console.error(`[location-notes] Cartrack ${res.status} for ${date}`);
      return NextResponse.json({ notes: {} });
    }
    const jobs: Job[] = (await res.json()).data ?? [];

    const notes: NoteMap = {};
    for (const j of jobs) {
      // The same two tests the feed applies, so a note can never appear for a trip the
      // lab's feed does not show.
      if (!(j.stops ?? []).some((s) => s.customer_id === code) && !isLabWatchedClient(j)) continue;
      if (!isClientPickupJob(j)) continue;
      const n = notesOf(j);
      if (n) notes[j.job_id] = n;
    }

    if (redis) {
      try { await redis.set(key, notes, { ex: CACHE_TTL_S }); } catch {}
    }
    return NextResponse.json({ notes });
  } catch (e) {
    // Loud on the server, empty to the phone. A note that never arrives is invisible on
    // the card — without this line the only symptom of a broken fetch is a feed that
    // quietly stops explaining itself.
    console.error("[location-notes]", e);
    return NextResponse.json({ notes: {} });
  }
}
