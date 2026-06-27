import { NextResponse } from "next/server";
import { loadPscRoutes } from "@/lib/psc-config";

export const runtime = "edge";
export const preferredRegion = "sin1";

// Data is a hard-coded constant ([[psc-routes-data]]); the app's own pages import it directly
// and never hit this route. Kept for any external callers — cache hard so it stays cheap.
const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
};

export async function GET() {
  try {
    const routes = await loadPscRoutes();
    return NextResponse.json({ data: routes }, { headers: CACHE_HEADERS });
  } catch (e) {
    return NextResponse.json(
      { data: [], error: String(e) },
      { status: 500 }
    );
  }
}
