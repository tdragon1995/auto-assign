import { NextRequest, NextResponse } from "next/server";
import { syncCartrackDetailPage, syncCartrackProfiles, syncLabcenterMetadata } from "@/lib/master-sync";
import { syncMasterSheet } from "@/lib/master-sheet-sync";
import { invalidateConfigCache, invalidateDriversCache } from "@/lib/config";

export const runtime = "nodejs";
export const preferredRegion = "sin1";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const phase = req.nextUrl.searchParams.get("phase") ?? "all";
  const editKey = process.env.MASTER_CLIENT_INFO_EDIT_KEY;
  const cronAuthorized = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
  const detailAuthorized = phase === "details" && !!editKey && req.headers.get("x-master-edit-key") === editKey;
  if (!cronAuthorized && !detailAuthorized) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
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
    if (profiles) { invalidateDriversCache(); await invalidateConfigCache(); }
    const imported = phase === "bootstrap" ? await syncMasterSheet() : null;
    const labcenter = phase === "metadata" ? await syncLabcenterMetadata(offset, limit)
      : phase === "all" && profiles?.newClientCodes.length ? await syncLabcenterMetadata(0, 200, profiles.newClientCodes) : null;
    if (labcenter) await invalidateConfigCache();
    return NextResponse.json({ ok: true, profiles: profiles && { ...profiles, newClientCodes: profiles.newClientCodes.length }, imported, labcenter });
  } catch (e) {
    console.error("Master Client Info sync failed:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 502 });
  }
}

/** An intentional refresh from the existing Config panel; no scheduled sync. */
export async function POST(req: NextRequest) {
  try {
    const phase = req.nextUrl.searchParams.get("phase") ?? "profiles";
    if (phase === "metadata") {
      const after = req.nextUrl.searchParams.get("after") ?? "";
      const limit = Number(req.nextUrl.searchParams.get("limit") ?? "100");
      if (!/^\d{0,64}$/.test(after) || !Number.isInteger(limit) || limit < 1 || limit > 200) return NextResponse.json({ok:false, error:"Invalid metadata batch"}, {status:400});
      const labcenter = await syncLabcenterMetadata(0, limit, undefined, after);
      await invalidateConfigCache();
      return NextResponse.json({ok:true, labcenter});
    }
    if (phase === "sheet") {
      const key = process.env.MASTER_CLIENT_INFO_EDIT_KEY;
      if (!key || req.headers.get("x-master-edit-key") !== key) return NextResponse.json({ error: "Master Client Info access denied" }, { status: 401 });
      const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
      const result = await syncMasterSheet(dryRun);
      return NextResponse.json({ ok: !result.blocked, ...result });
    }
    if (phase !== "profiles") throw new Error("Invalid sync phase");
    const profiles = await syncCartrackProfiles();
    invalidateDriversCache();
    await invalidateConfigCache();
    const labcenter = profiles.newClientCodes.length
      ? await syncLabcenterMetadata(0, 200, profiles.newClientCodes) : null;
    if (labcenter) await invalidateConfigCache();
    return NextResponse.json({ ok: true, profiles: { ...profiles, newClientCodes: profiles.newClientCodes.length }, labcenter });
  } catch (e) {
    console.error("Master Client Info manual sync failed:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 502 });
  }
}
