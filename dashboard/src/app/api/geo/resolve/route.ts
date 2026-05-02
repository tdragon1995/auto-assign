import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";
export const preferredRegion = "sin1";

// Follows Google Maps short links (maps.app.goo.gl, goo.gl/maps) and returns the expanded URL.
// Also extracts lat/lon if found in the final URL or page body.

type Coords = { lat: number; lon: number };

// Patterns where the first capture is latitude, second is longitude.
const LATLON_PATTERNS_LATFIRST: RegExp[] = [
  /@(-?\d+\.\d+),(-?\d+\.\d+)/,                                  // /@lat,lon[,zoom]
  /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,                              // !3d<lat>!4d<lon> (place data)
  /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/,                             // ?q=lat,lon
  /[?&]query=(-?\d+\.\d+),(-?\d+\.\d+)/,                         // ?api=1&query=lat,lon
  /[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/,                            // ?ll=lat,lon
  /[?&]center=(-?\d+\.\d+),(-?\d+\.\d+)/,                        // ?center=lat,lon
  /[?&]destination=(-?\d+\.\d+),(-?\d+\.\d+)/,                   // ?destination=lat,lon
  /"latitude"\s*:\s*(-?\d+\.\d+)\s*,\s*"longitude"\s*:\s*(-?\d+\.\d+)/, // JSON
];

// Patterns where the first capture is longitude, second is latitude.
const LATLON_PATTERNS_LONFIRST: RegExp[] = [
  /!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)/,                              // !2d<lon>!3d<lat> (embed/viewport)
];

function looksLikePlausibleCoord(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= -85 && lat <= 85
    && lon >= -180 && lon <= 180
    && (Math.abs(lat) > 0.001 || Math.abs(lon) > 0.001);
}

function extractLatLon(text: string): Coords | null {
  for (const re of LATLON_PATTERNS_LATFIRST) {
    const m = text.match(re);
    if (m) {
      const lat = parseFloat(m[1]);
      const lon = parseFloat(m[2]);
      if (looksLikePlausibleCoord(lat, lon)) return { lat, lon };
    }
  }
  for (const re of LATLON_PATTERNS_LONFIRST) {
    const m = text.match(re);
    if (m) {
      const lon = parseFloat(m[1]);
      const lat = parseFloat(m[2]);
      if (looksLikePlausibleCoord(lat, lon)) return { lat, lon };
    }
  }
  return null;
}

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const FETCH_HEADERS: HeadersInit = {
  "User-Agent": DESKTOP_UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// Pull `continue=` target out of consent.google.com URLs.
function consentContinueTarget(url: string): string | null {
  if (!/consent\.google\.[a-z.]+/i.test(url)) return null;
  try {
    const u = new URL(url);
    const cont = u.searchParams.get("continue");
    return cont || null;
  } catch {
    return null;
  }
}

// Pull a meta-refresh or JS-redirect target out of an HTML body.
function htmlRedirectTarget(html: string): string | null {
  const meta = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>]+)/i);
  if (meta) return meta[1].trim();
  const jsLoc = html.match(/(?:location\.replace|location\.href\s*=|window\.location\s*=)\s*["']([^"']+)["']/i);
  if (jsLoc) return jsLoc[1].trim();
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();
    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "Missing url" }, { status: 400 });
    }

    let finalUrl = url.trim();
    let coords = extractLatLon(finalUrl);

    if (!coords && /goo\.gl|app\.goo\.gl|maps\.google|google\.[a-z.]+\/maps/.test(finalUrl)) {
      let current = finalUrl;
      const seen = new Set<string>();

      for (let i = 0; i < 10 && !coords; i++) {
        if (seen.has(current)) break;
        seen.add(current);

        const consentTarget = consentContinueTarget(current);
        if (consentTarget) {
          current = consentTarget;
          coords = extractLatLon(current);
          continue;
        }

        const res = await fetch(current, { redirect: "manual", headers: FETCH_HEADERS });
        const loc = res.headers.get("location");
        if (loc) {
          current = new URL(loc, current).toString();
          finalUrl = current;
          const hit = extractLatLon(current);
          if (hit) { coords = hit; break; }
          continue;
        }
        // No redirect — body may have a meta-refresh, JS redirect, or embedded coords.
        const text = await res.text();
        finalUrl = res.url || current;
        coords = extractLatLon(finalUrl) ?? extractLatLon(text);
        if (coords) break;
        const next = htmlRedirectTarget(text);
        if (next) {
          current = new URL(next, finalUrl).toString();
          continue;
        }
        break;
      }

      // Last-ditch: GET with auto-follow and parse the body.
      if (!coords) {
        const res = await fetch(current, { headers: FETCH_HEADERS });
        const text = await res.text();
        finalUrl = res.url || current;
        coords = extractLatLon(finalUrl) ?? extractLatLon(text);
      }
    }

    if (!coords) {
      return NextResponse.json({ error: "Không tìm thấy toạ độ trong link", resolved_url: finalUrl }, { status: 422 });
    }
    return NextResponse.json({ latitude: coords.lat, longitude: coords.lon, resolved_url: finalUrl });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
