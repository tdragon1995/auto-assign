import { NextRequest, NextResponse } from "next/server";
import { importCurrentConfig, syncCartrackProfiles, syncLabcenterMetadata } from "@/lib/master-sync";

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
    if (!["all", "profiles", "metadata", "bootstrap"].includes(phase)) throw new Error("Invalid sync phase");
    const offset = Number(req.nextUrl.searchParams.get("offset") ?? "0");
    if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid offset");
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? "200");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid limit");
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
