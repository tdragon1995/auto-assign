import { NextRequest, NextResponse } from "next/server";
import { googleAutocomplete, googleKey } from "@/lib/google-places";

export const runtime = "edge";
export const preferredRegion = "sin1";

// Proxies Goong "Place Search by Keyword with Autocomplete" to keep GOONG_API_KEY off the client.
// https://docs.goong.io/rest/place/#places-search-by-keyword-with-autocomplete
//
// Query: ?input=...&lat=10.7626&lon=106.6602&google=1
// Response: { predictions: [{ place_id, description, structured_formatting: { main_text, secondary_text } }] }
//
// With ?google=1, tries Google Places (New) first (better VN results) and falls
// back to Goong on any miss. Both sales tabs (KH mới, Cập Nhật SĐT & Địa Chỉ)
// pass this — their street/district derivation already has a Goong-terms/
// compound fast path with a main_text / point-in-polygon fallback for when
// those fields are absent, which is what a Google prediction hits.

const HCMC_LAT = 10.7626;
const HCMC_LON = 106.6602;

export async function GET(req: NextRequest) {
  const apiKey = process.env.GOONG_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "GOONG_API_KEY not set" }, { status: 500 });

  const input = req.nextUrl.searchParams.get("input")?.trim();
  if (!input) return NextResponse.json({ predictions: [] });

  if (req.nextUrl.searchParams.get("google") === "1" && googleKey()) {
    const g = await googleAutocomplete(input);
    // null = Google failed → fall through to Goong. [] = Google ok but no hits;
    // return it (don't second-guess a clean empty result with a Goong call).
    if (g !== null) return NextResponse.json({ predictions: g, source: "google" });
  }

  const lat = req.nextUrl.searchParams.get("lat") || String(HCMC_LAT);
  const lon = req.nextUrl.searchParams.get("lon") || String(HCMC_LON);

  const url = new URL("https://rsapi.goong.io/Place/AutoComplete");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("input", input);
  url.searchParams.set("location", `${lat},${lon}`);

  try {
    const res = await fetch(url.toString());
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json({ error: data?.message ?? "Goong autocomplete failed" }, { status: 502 });
    }
    return NextResponse.json({ predictions: data?.predictions ?? [] });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
