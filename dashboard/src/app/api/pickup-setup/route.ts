import { NextRequest, NextResponse } from "next/server";
import { applySetupAction, pickupSetupReport, type SetupAction } from "@/lib/pickup-setup";
import { supabaseConfigured } from "@/lib/supabase-rest";

export const runtime = "nodejs";
export const preferredRegion = "sin1";
export const maxDuration = 60;

/**
 * Pickup setup check for the Config tab: ETA proposals from measured medians,
 * and places where Labcenter no longer matches our master copy. Fetched only
 * when the tab is open — no poll, no cache, no Redis.
 */
export async function GET() {
  if (!supabaseConfigured()) return NextResponse.json({ error: "Supabase chưa được cấu hình" }, { status: 503 });
  try {
    return NextResponse.json(await pickupSetupReport());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

/** One admin decision: approve_eta {mins}, repush, or accept_lc. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Partial<SetupAction> & { mins?: number } | null;
  const id = Number(body?.lc_location_id);
  if (!body || !Number.isInteger(id)) return NextResponse.json({ ok: false, error: "Thiếu địa điểm" }, { status: 400 });
  if (body.action !== "approve_eta" && body.action !== "repush" && body.action !== "accept_lc") {
    return NextResponse.json({ ok: false, error: "Thao tác không hợp lệ" }, { status: 400 });
  }
  if (body.action === "approve_eta" && !Number.isFinite(Number(body.mins))) {
    return NextResponse.json({ ok: false, error: "Thiếu số phút" }, { status: 400 });
  }
  try {
    const r = await applySetupAction({ ...body, lc_location_id: id, mins: Number(body.mins) } as SetupAction);
    return NextResponse.json(r, { status: r.ok ? 200 : 409 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
