import { NextRequest, NextResponse } from "next/server";
import { getTimelineRoutes } from "@/lib/cartrack";
import { buildBranchDay } from "@/lib/branch-visits";
import { vnDate } from "@/lib/time";
import type { Env } from "@/lib/cartrack";

// PREVIEW ONLY — feeds /qr-preview so the courier-grouped layout can be judged against
// real data before anything on /qr changes. Deliberately not cached and not slimmed:
// this is a decision aid, not a hot path, and nobody scans a QR code onto it.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const date = req.nextUrl.searchParams.get("date") ?? vnDate(new Date());
  const code = req.nextUrl.searchParams.get("code");

  try {
    const routes = await getTimelineRoutes(date, env);
    if (!routes) {
      return NextResponse.json({ error: "Cartrack timeline unavailable (CARTRACK_WEB_PASS)" }, { status: 502 });
    }

    // ?list=1 — every branch on today's routes with its reading ladder, so the picker
    // can lead with the cases that actually decide the design.
    if (!code) {
      const names = new Map<string, string>();
      for (const r of routes) {
        for (const s of r.orderedStops ?? []) {
          if (s.customerId) names.set(s.customerId, s.customerName);
        }
      }
      const branches = [...names]
        .map(([branch, name]) => {
          const day = buildBranchDay(routes, branch);
          return { code: branch, name, jobs: day.totals.jobs, couriers: day.totals.couriers };
        })
        .filter((b) => b.jobs > 0)
        .sort((a, b) => b.jobs - a.jobs);
      return NextResponse.json({ date, branches });
    }

    const day = buildBranchDay(routes, code);
    const name = routes
      .flatMap((r) => r.orderedStops ?? [])
      .find((s) => s.customerId === code)?.customerName ?? null;
    return NextResponse.json({ date, name, ...day });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
