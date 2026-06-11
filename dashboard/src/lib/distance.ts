const GOONG_API = "https://rsapi.goong.io/v2/distancematrix";

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/** 1→1 road distance via Goong (motorbike). Returns km, or null if unavailable. */
export async function goongDistanceKm(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
  apiKey?: string
): Promise<number | null> {
  const results = await goongMatrix(fromLat, fromLon, [{ lat: toLat, lon: toLon }], apiKey);
  return results[0]?.distance_km ?? null;
}

export interface GoongResult {
  distance_km: number;
  eta_mins: number;
}

/** 1→N batch road distance via Goong (motorbike). Returns null per destination if unavailable. */
export async function goongMatrix(
  originLat: number,
  originLon: number,
  destinations: { lat: number; lon: number }[],
  apiKey: string = process.env.GOONG_API_KEY ?? ""
): Promise<(GoongResult | null)[]> {
  if (!apiKey || destinations.length === 0) return destinations.map(() => null);

  const destStr = destinations.map((d) => `${d.lat},${d.lon}`).join("|");
  const url = `${GOONG_API}?origins=${originLat},${originLon}&destinations=${encodeURIComponent(destStr)}&vehicle=bike&api_key=${apiKey}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return destinations.map(() => null);
    const data = await res.json();
    const elements: { status: string; distance: { value: number }; duration: { value: number } }[] =
      data.rows?.[0]?.elements ?? [];
    return destinations.map((_, i) => {
      const el = elements[i];
      if (!el || el.status !== "OK") return null;
      return {
        distance_km: Math.round(el.distance.value / 100) / 10,
        eta_mins: Math.round(el.duration.value / 60),
      };
    });
  } catch {
    return destinations.map(() => null);
  }
}
