import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";
export const preferredRegion = "sin1";

// Follows Google Maps short links (maps.app.goo.gl, goo.gl/maps) and returns the expanded URL.
// Also extracts lat/lon if found in the final URL.

const LATLON_PATTERNS = [
  /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,              // /@lat,lon,zoom
  /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,          // !3d<lat>!4d<lon>
  /[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,         // ?q=lat,lon
  /[?&]ll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,        // ?ll=lat,lon
  /\/(-?\d+\.\d+),(-?\d+\.\d+)/,                       // /<lat>,<lon>
];

function extractLatLon(url: string): { lat: number; lon: number } | null {
  for (const re of LATLON_PATTERNS) {
    const m = url.match(re);
    if (m) {
      const lat = parseFloat(m[1]);
      const lon = parseFloat(m[2]);
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) return { lat, lon };
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();
    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "Missing url" }, { status: 400 });
    }

    // Try client-side parseable URL first
    let finalUrl = url.trim();
    let coords = extractLatLon(finalUrl);

    // Short link — follow redirects up to 5 times
    if (!coords && /goo\.gl|app\.goo\.gl/.test(finalUrl)) {
      let current = finalUrl;
      for (let i = 0; i < 5; i++) {
        const res = await fetch(current, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
        const loc = res.headers.get("location");
        if (!loc) break;
        current = loc;
        const hit = extractLatLon(current);
        if (hit) { coords = hit; finalUrl = current; break; }
      }
      // If still no coords, fall back to GET with follow and parse final body
      if (!coords) {
        const res = await fetch(current, { headers: { "User-Agent": "Mozilla/5.0" } });
        const text = await res.text();
        coords = extractLatLon(res.url) ?? extractLatLon(text);
        finalUrl = res.url;
      }
    }

    if (!coords) return NextResponse.json({ error: "Không tìm thấy toạ độ trong link", resolved_url: finalUrl }, { status: 422 });
    return NextResponse.json({ latitude: coords.lat, longitude: coords.lon, resolved_url: finalUrl });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
