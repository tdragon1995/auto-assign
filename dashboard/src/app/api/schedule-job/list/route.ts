import { NextResponse } from "next/server";
import { loadScheduleJobRows } from "@/lib/schedule-job";
import { masterScheduleEnabled } from "@/lib/master-schedule";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

/** Read schedule definitions only; never creates or assigns jobs. */
export async function GET() {
  try {
    const rows = await loadScheduleJobRows();
    return NextResponse.json({ rows,source:masterScheduleEnabled()?"supabase":"sheet" });
  } catch (e) {
    return NextResponse.json({ rows: [], error: String(e) }, { status: 500 });
  }
}
