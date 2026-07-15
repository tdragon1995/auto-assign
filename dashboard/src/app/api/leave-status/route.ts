import { NextRequest, NextResponse } from "next/server";
import { loadLeaveEntries, leaveEntriesOnDate, invalidateLeaveCache } from "@/lib/leave-config";
import { addDays, vnDate } from "@/lib/time";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

/** GET — drivers on leave today and tomorrow (Saigon dates), from the Leave
 *  Status sheet. Powers the dashboard "Cần xử lý" leave-status panel.
 *  `?fresh=1` busts the 5-min sheet cache first (dashboard Refresh button). */
export async function GET(req: NextRequest) {
  try {
    if (new URL(req.url).searchParams.get("fresh")) invalidateLeaveCache();
    const entries = await loadLeaveEntries();
    const today = vnDate();
    const tomorrow = addDays(today, 1);
    return NextResponse.json({
      today: leaveEntriesOnDate(today, entries),
      tomorrow: leaveEntriesOnDate(tomorrow, entries),
    });
  } catch (e) {
    return NextResponse.json({ today: [], tomorrow: [], error: String(e) }, { status: 500 });
  }
}
