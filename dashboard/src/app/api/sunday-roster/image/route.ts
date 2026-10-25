import { NextRequest, NextResponse } from "next/server";
import { isSunday } from "@/lib/sunday-roster";
import { imageSigOk, loadSundayLines } from "@/lib/sunday-roster-zalo";
import { renderRosterImage } from "@/lib/sunday-roster-image";
import { isPublished } from "@/lib/sunday-roster-post";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

// GET /api/sunday-roster/image?date=YYYY-MM-DD&sig=… — the roster as a PNG for
// the drivers' Zalo group (Zalo's sendPhoto fetches it). Public because Zalo
// fetches it with no credentials; the signature is what keeps the names on it
// from being one guessable URL away.

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date");
  if (!isSunday(date) || !imageSigOk(date, req.nextUrl.searchParams.get("sig"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const lines = (await loadSundayLines(date)).filter((l) => isPublished(l.area));
  return renderRosterImage(date, lines);
}
