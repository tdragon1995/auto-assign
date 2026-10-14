import { invalidateShiftCache } from "@/lib/shift-window";
import { invalidateLeaveCache } from "@/lib/leave-config";
import { invalidateSuppressionCache } from "@/lib/leave-suppression";
import { NextRequest, NextResponse } from "next/server";
import { loadConfigFromSheets, invalidateConfigCache, loadDriversFromSheet, invalidateDriversCache } from "@/lib/config";
import { loadPscRoutes, invalidatePscCache } from "@/lib/psc-config";
import { invalidateStartLocCache } from "@/lib/assign";

export async function GET(req: NextRequest) {
  try {
    // ?refresh=1 (the Refresh buttons) busts the caches so fresh sheet data is loaded.
    // The config one is awaited because it also bumps the shared stamp that tells every
    // OTHER serverless instance to drop its copy. A plain GET (dashboard page load) only
    // reads: busting on every page open re-parsed the whole config here AND in every
    // other instance — the cron engine included — each time an admin opened the page.
    if (req.nextUrl.searchParams.get("refresh") === "1") {
      await Promise.all([invalidateConfigCache(), invalidateShiftCache(), invalidateLeaveCache()]);
      invalidateSuppressionCache();
      invalidateDriversCache();
      invalidatePscCache();
      invalidateStartLocCache();
    }

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
