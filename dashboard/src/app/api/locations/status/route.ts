import { NextRequest, NextResponse } from "next/server";
import { setLocationStatus } from "@/lib/location-status";

/**
 * POST { customer_id, active } — disable (false) or re-enable (true) a client
 * location: Labcenter `is_active`, then the "{inactive}" prefix on the Cartrack
 * name. See location-status.ts for the order and why a partial write is safe.
 *
 * The sheets pick the new name up on their own schedule: the Location tab at the
 * next Apps Script "Fetch Locations", the config tab through its lookup on it.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const customerId = typeof body.customer_id === "string" ? body.customer_id.trim() : "";
  if (!/^[0-9a-f-]{16,}$/i.test(customerId) || typeof body.active !== "boolean") {
    return NextResponse.json({ ok: false, error: "Cần customer_id (Cartrack) và active: true|false" }, { status: 400 });
  }
  const res = await setLocationStatus(customerId, body.active);
  return NextResponse.json(res, { status: res.ok ? 200 : res.partial ? 207 : 502 });
}
