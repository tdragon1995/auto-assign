import { NextResponse } from "next/server";
import { sbSelectAll } from "@/lib/supabase-rest";

// The dashboard asks this on every page open. It lives apart from /api/misa-sync on
// purpose: that route pulls in the whole sync (config, Cartrack, Labcenter) and is
// pinned to its own region, so each call started a cold copy of all of it — ~0.7s of
// CPU to read a table that is usually empty. This one loads only the Supabase helper.
export async function GET() {
  const rows = await sbSelectAll<{ client_code: string; customer_id: string; name: string; kind: string; detail: string; created_at: string }>(
    "master_sync_issues", "select=client_code,customer_id,name,kind,detail,created_at", "client_code.asc,customer_id.asc,id.asc");
  return NextResponse.json({ issues: rows, checked_at: rows.reduce((a, r) => (r.created_at > a ? r.created_at : a), "") || null });
}
