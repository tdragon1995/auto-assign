import { NextRequest, NextResponse } from "next/server";
import { GOOGLE_PLACE_PREFIX, googlePlaceDetail } from "@/lib/google-places";

export const runtime = "edge";
export const preferredRegion = "sin1";

// Proxies Goong "Place Detail" to resolve a place_id from autocomplete to lat/lon + formatted address.
// Query: ?place_id=...
// Response: { latitude, longitude, formatted_address, name }
//
// A "g:"-prefixed place_id came from Google autocomplete, so resolve it via
// Google; everything else stays on Goong.

export async function GET(req: NextRequest) {
  const placeId = req.nextUrl.searchParams.get("place_id")?.trim();
  if (!placeId) return NextResponse.json({ error: "Missing place_id" }, { status: 400 });

  if (placeId.startsWith(GOOGLE_PLACE_PREFIX)) {
    const g = await googlePlaceDetail(placeId);
    if (g) return NextResponse.json({ ...g, source: "google" });
    return NextResponse.json({ error: "Google place detail failed" }, { status: 502 });
  }

  const apiKey = process.env.GOONG_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "GOONG_API_KEY not set" }, { status: 500 });

  const url = new URL("https://rsapi.goong.io/Place/Detail");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("place_id", placeId);

  try {
    const res = await fetch(url.toString());
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json({ error: data?.message ?? "Goong place detail failed" }, { status: 502 });
    }
    const result = data?.result;
    const loc = result?.geometry?.location;
    if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
      return NextResponse.json({ error: "No coordinates in Goong response" }, { status: 422 });
    }
    return NextResponse.json({
      latitude: loc.lat,
      longitude: loc.lng,
      formatted_address: result.formatted_address ?? "",
      name: result.name ?? "",
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
