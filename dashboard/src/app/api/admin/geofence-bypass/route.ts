import { NextRequest, NextResponse } from "next/server";
import type { Env } from "@/lib/cartrack";
import { openGeofence } from "@/lib/geofence-bypass";

// ── POST /api/admin/geofence-bypass — let a driver complete stops off-site for 5 min ──
// Body: { driver_id } (delivery driver id). The assign cron restores enforcement.

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const { driver_id } = await req.json().catch(() => ({}));
  if (typeof driver_id !== "string" || !/^[0-9a-f-]{36}$/i.test(driver_id)) {
    return NextResponse.json({ error: "driver_id không hợp lệ" }, { status: 400 });
  }
  const out = await openGeofence(driver_id, env);
  if ("error" in out) return NextResponse.json({ error: out.error }, { status: 502 });
  return NextResponse.json({ success: true, until: out.until });
}
