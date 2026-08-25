// Google Places API (New) — address autocomplete + detail.
//
// Uses the Cartrack (sister-company) Google Maps key. That key is
// referer-restricted to fleetweb-vn.cartrack.com, so requests carry the matching
// Referer/Origin — the same authorized-as-Cartrack posture the rest of this app
// already uses (CARTRACK_WEB_PASS / ct_login). Callers fall back to Goong when
// the key is absent or Google errors, so a rotated/tightened key degrades
// gracefully instead of breaking address search.
//
// Predictions are returned in the SAME shape Goong's proxy uses (place_id,
// description, structured_formatting) so the UI needs no branching. Google place
// ids are prefixed "g:" so /api/geo/place knows to resolve them via Google.

const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const DETAIL_BASE = "https://places.googleapis.com/v1/places";
const DEFAULT_REFERER = "https://fleetweb-vn.cartrack.com/";

// HCM city centre — Google biases toward this without hard-excluding valid
// out-of-town matches (regionCode already pins the country to VN).
const HCMC = { latitude: 10.7769, longitude: 106.7009 };

export const GOOGLE_PLACE_PREFIX = "g:";

export function googleKey(): string | null {
  return process.env.GOOGLE_PLACES_API_KEY || null;
}

function headers(): Record<string, string> {
  const referer = process.env.GOOGLE_PLACES_REFERER || DEFAULT_REFERER;
  return {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY ?? "",
    Referer: referer,
    Origin: referer.replace(/\/$/, ""),
  };
}

type Prediction = {
  place_id: string;
  description: string;
  structured_formatting: { main_text: string; secondary_text: string };
};

type GooglePrediction = {
  placePrediction?: {
    placeId?: string;
    text?: { text?: string };
    structuredFormat?: {
      mainText?: { text?: string };
      secondaryText?: { text?: string };
    };
  };
};

// POST places:autocomplete. Returns null on any failure so the caller can fall
// back to Goong; empty-but-ok returns [].
export async function googleAutocomplete(input: string): Promise<Prediction[] | null> {
  if (!googleKey()) return null;
  try {
    const res = await fetch(AUTOCOMPLETE_URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        input,
        languageCode: "vi",
        regionCode: "vn",
        locationBias: { circle: { center: HCMC, radius: 50000 } },
      }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const suggestions: GooglePrediction[] = data?.suggestions ?? [];
    return suggestions
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<GooglePrediction["placePrediction"]> => !!p?.placeId)
      .map((p) => ({
        place_id: `${GOOGLE_PLACE_PREFIX}${p.placeId}`,
        description: p.text?.text ?? "",
        structured_formatting: {
          main_text: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
          secondary_text: p.structuredFormat?.secondaryText?.text ?? "",
        },
      }));
  } catch {
    return null;
  }
}

// GET places/{id}. `placeId` may carry the "g:" prefix; it is stripped here.
export async function googlePlaceDetail(
  placeId: string,
): Promise<{ latitude: number; longitude: number; formatted_address: string; name: string } | null> {
  if (!googleKey()) return null;
  const id = placeId.startsWith(GOOGLE_PLACE_PREFIX) ? placeId.slice(GOOGLE_PLACE_PREFIX.length) : placeId;
  try {
    const res = await fetch(`${DETAIL_BASE}/${encodeURIComponent(id)}`, {
      headers: { ...headers(), "X-Goog-FieldMask": "location,formattedAddress,displayName" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const d = await res.json().catch(() => ({}));
    const loc = d?.location;
    if (!loc || typeof loc.latitude !== "number" || typeof loc.longitude !== "number") return null;
    return {
      latitude: loc.latitude,
      longitude: loc.longitude,
      formatted_address: d.formattedAddress ?? "",
      name: d.displayName?.text ?? "",
    };
  } catch {
    return null;
  }
}
