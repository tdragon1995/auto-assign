import { NextResponse } from "next/server";
import { loadConfigFromSheets, invalidateConfigCache, driversFromConfig } from "@/lib/config";
import { loadPscRoutes, invalidatePscCache } from "@/lib/psc-config";
import { invalidateStartLocCache } from "@/lib/assign";

export async function GET() {
  try {
    // Bust the caches so fresh sheet data (and start-location coords) is loaded
    invalidateConfigCache();
    invalidatePscCache();
    invalidateStartLocCache();

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
      // Derived from the config above — no extra fetch. Populates the manual
      // "Gán thủ công" driver picker in the Cần xử lý panel.
      drivers: driversFromConfig(config),
      status: "ok",
    });
  } catch (e) {
    return NextResponse.json(
      { mappingCount: 0, pscRouteCount: 0, status: "error", error: String(e) },
      { status: 500 }
    );
  }
}
