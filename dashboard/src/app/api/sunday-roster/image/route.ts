import { NextRequest, NextResponse } from "next/server";
import { isSunday } from "@/lib/sunday-roster";
import { drawImage, imageSigOk, loadSundayLines, preparedImage } from "@/lib/sunday-roster-zalo";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

// GET /api/sunday-roster/image?date=YYYY-MM-DD&kind=roster|open&stage=draft|final&sig=…&v=…
// A Sunday roster picture for the drivers' Zalo groups (Zalo's sendPhoto
// fetches it). Public because Zalo fetches it with no credentials; the
// signature is what keeps the names on it from being one guessable URL away.

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const date = q.get("date");
  if (!isSunday(date) || !imageSigOk(date, q.get("sig"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const kind = q.get("kind") === "open" ? "open" : "roster";
  const stage = q.get("stage") === "draft" ? "draft" : "final";
  // A link the bot sent carries the picture drawn just before sending: answer
  // with it at once, sized, so Zalo's fetch does not wait on a 6–8 s render.
  const png = (await preparedImage(date, kind, q.get("v"))) ?? (await drawImage(date, kind, stage, await loadSundayLines(date)));
  if (!png) return NextResponse.json({ error: "Không còn ca trống" }, { status: 404 });
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Content-Length": String(png.length), "Cache-Control": "public, max-age=86400" },
  });
}
