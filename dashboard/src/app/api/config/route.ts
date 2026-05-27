import { NextResponse } from "next/server";
import { loadConfigFromSheets, invalidateConfigCache } from "@/lib/config";
import { loadPscRoutes, invalidatePscCache } from "@/lib/psc-config";

export async function GET() {
  try {
    // Bust both caches so fresh sheet data is loaded
    invalidateConfigCache();
    invalidatePscCache();

    const [config, pscRoutes] = await Promise.all([
      loadConfigFromSheets(),
      loadPscRoutes().catch(() => []),
    ]);

    if (!config) {
      return NextResponse.json(
        { mappingCount: 0, pscRouteCount: 0, status: "error", error: "Failed to load config" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      mappingCount: config.mappings.length,
      pscRouteCount: pscRoutes.length,
      jobMaxAge: config.job_max_age_minutes,
      status: "ok",
    });
  } catch (e) {
    return NextResponse.json(
      { mappingCount: 0, pscRouteCount: 0, status: "error", error: String(e) },
      { status: 500 }
    );
  }
}
