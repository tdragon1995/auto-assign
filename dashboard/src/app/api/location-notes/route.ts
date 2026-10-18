import { NextRequest, NextResponse } from "next/server";
import type { Env } from "@/lib/cartrack";
import { MAX_NOTE_IDS, notesFor } from "@/lib/trip-notes";

export const preferredRegion = "sin1";

/**
 * GET /api/location-notes?date=YYYY-MM-DD&ids=<job_id>,<job_id>,…
 *
 * Notes and photos for the given trips, asking Cartrack for any not yet saved. The /qr
 * page calls it only for the ids the trip-list reply came back without — see
 * @/lib/trip-notes.
 */
export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const date = req.nextUrl.searchParams.get("date");
  const ids = (req.nextUrl.searchParams.get("ids") ?? "")
    .split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_NOTE_IDS);

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
