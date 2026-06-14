import { NextResponse } from "next/server";
import { loadScheduleJobRows } from "@/lib/schedule-job";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

/** GET — all fixed-schedule definitions from the sheet (read-only).
 *  Powers the dashboard "Lịch cố định" tab; one sheet fetch, no Cartrack calls. */
export async function GET() {
  try {
    const rows = await loadScheduleJobRows();
    return NextResponse.json({ rows });
  } catch (e) {
    return NextResponse.json({ rows: [], error: String(e) }, { status: 500 });
  }
}
