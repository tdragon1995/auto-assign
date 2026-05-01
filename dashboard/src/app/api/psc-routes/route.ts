import { NextResponse } from "next/server";
import { loadPscRoutes, loadDriverMappings, findDriverForPickup } from "@/lib/psc-config";

export const runtime = "edge";
export const preferredRegion = "sin1";

export async function GET() {
  try {
    const [routes] = await Promise.all([
      loadPscRoutes(),
      loadDriverMappings(),
    ]);

    const enriched = routes.map((r) => {
      const driver = findDriverForPickup(r.pickup);
      return {
        ...r,
        driver_id: driver?.driver_id ?? null,
        driver_name: driver?.driver_name ?? null,
      };
    });

    return NextResponse.json({ data: enriched });
  } catch (e) {
    return NextResponse.json(
      { data: [], error: String(e) },
      { status: 500 }
    );
  }
}
