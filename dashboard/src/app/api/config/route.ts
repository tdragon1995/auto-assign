import { NextResponse } from "next/server";
import { loadConfigFromSheets, invalidateConfigCache, loadDriversFromSheet, invalidateDriversCache } from "@/lib/config";
import { loadPscRoutes, invalidatePscCache } from "@/lib/psc-config";
import { invalidateStartLocCache } from "@/lib/assign";

export async function GET() {
  try {
    // Bust the caches so fresh sheet data (and start-location coords) is loaded.
    // The config one is awaited because it also bumps the shared stamp that tells every
    // OTHER serverless instance to drop its copy — the whole point of pressing Refresh.
    await invalidateConfigCache();
    invalidateDriversCache();
    invalidatePscCache();
    invalidateStartLocCache();

    const [config, drivers, pscRoutes] = await Promise.all([
      loadConfigFromSheets(),
      loadDriversFromSheet(),
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
      // Fetched from dedicated drivers sheet. Populates the manual
      // "Gán thủ công" driver picker in the Cần xử lý panel.
      drivers,
      status: "ok",
    });
  } catch (e) {
    return NextResponse.json(
      { mappingCount: 0, pscRouteCount: 0, status: "error", error: String(e) },
      { status: 500 }
    );
  }
}
