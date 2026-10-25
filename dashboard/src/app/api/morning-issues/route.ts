import { NextResponse } from "next/server";
import { sbSelectAll } from "@/lib/supabase-rest";
import { sharedRedis } from "@/lib/redis";
import { MORNING_RUN_KEY, morningRunFailure } from "@/lib/morning-sync-trigger";

// The dashboard asks this on every page open. It lives apart from /api/misa-sync (and
// outside its folder, which next.config bundles with Chromium) on
// purpose: that route pulls in the whole sync (config, Cartrack, Labcenter) and is
// pinned to its own region, so each call started a cold copy of all of it — ~0.7s of
// CPU to read a table that is usually empty. This one loads only the Supabase and Redis
// helpers (one GET for the run's status).
export async function GET() {
  // A failed run (MISA leave not written) belongs on the dashboard, not only in Redis.
  const run = sharedRedis()?.get<Parameters<typeof morningRunFailure>[0]>(MORNING_RUN_KEY).catch(() => null) ?? null;
  const rows = await sbSelectAll<{ client_code: string; customer_id: string; name: string; kind: string; detail: string; created_at: string }>(
    "master_sync_issues", "select=client_code,customer_id,name,kind,detail,created_at", "client_code.asc,customer_id.asc,id.asc");
  return NextResponse.json({ sync_failure: morningRunFailure(await run), issues: rows, checked_at: rows.reduce((a, r) => (r.created_at > a ? r.created_at : a), "") || null });
}
