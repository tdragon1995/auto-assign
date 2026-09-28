import { NextRequest, NextResponse } from "next/server";
import { importCurrentConfig, syncCartrackDetailPage, syncCartrackProfiles, syncLabcenterMetadata } from "@/lib/master-sync";

export const runtime = "nodejs";
export const preferredRegion = "sin1";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const phase = req.nextUrl.searchParams.get("phase") ?? "all";
    if (!["all", "profiles", "metadata", "bootstrap", "details"].includes(phase)) throw new Error("Invalid sync phase");
    const offset = Number(req.nextUrl.searchParams.get("offset") ?? "0");
    if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid offset");
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? "200");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid limit");
    if (phase === "details") {
      const kind = req.nextUrl.searchParams.get("kind");
      if (kind !== "customers" && kind !== "drivers") throw new Error("Invalid detail kind");
      return NextResponse.json({ ok: true, details: await syncCartrackDetailPage(kind, offset, limit) });
    }
    const profiles = phase === "all" || phase === "profiles" || phase === "bootstrap" ? await syncCartrackProfiles() : null;
    const imported = phase === "bootstrap" ? await importCurrentConfig() : null;
    const labcenter = phase === "metadata" ? await syncLabcenterMetadata(offset, limit)
      : phase === "all" && profiles?.newClientCodes.length ? await syncLabcenterMetadata(0, 200, profiles.newClientCodes) : null;
    return NextResponse.json({ ok: true, profiles: profiles && { ...profiles, newClientCodes: profiles.newClientCodes.length }, imported, labcenter });
  } catch (e) {
    console.error("Master Client Info sync failed:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 502 });
  }
}

/** An intentional refresh from the existing Config panel; no scheduled sync. */
export async function POST(req: NextRequest) {
  const key = process.env.MASTER_CLIENT_INFO_EDIT_KEY;
  if (!key || req.headers.get("x-master-edit-key") !== key) {
    return NextResponse.json({ error: "Master Client Info access denied" }, { status: 401 });
  }
  try {
    const profiles = await syncCartrackProfiles();
    const labcenter = profiles.newClientCodes.length
      ? await syncLabcenterMetadata(0, 200, profiles.newClientCodes) : null;
    return NextResponse.json({ ok: true, profiles: { ...profiles, newClientCodes: profiles.newClientCodes.length }, labcenter });
  } catch (e) {
    console.error("Master Client Info manual sync failed:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 502 });
  }
}
