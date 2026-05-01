import { NextResponse } from "next/server";
import { loadPscRoutes } from "@/lib/psc-config";

export const runtime = "edge";
export const preferredRegion = "sin1";

export async function GET() {
  try {
    const routes = await loadPscRoutes();
    return NextResponse.json({ data: routes });
  } catch (e) {
    return NextResponse.json(
      { data: [], error: String(e) },
      { status: 500 }
    );
  }
}
