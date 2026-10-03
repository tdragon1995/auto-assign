import { NextResponse } from "next/server";
import { fetchSheetRows, SHEET_CONTRACT, SHEET_GID } from "@/lib/sheets";
import { masterEnabled } from "@/lib/master-store";
import { masterChoices } from "@/lib/master-choices";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

/** Use the same profile source as Config; fixed schedules still live in Sheet. */
export async function GET() {
  try {
    if(masterEnabled()) {
      const {locations,drivers}=await masterChoices();
      return NextResponse.json({source:"supabase",locations,drivers},{headers:{"Cache-Control":"no-store"}});
    }
    const rows = await fetchSheetRows(SHEET_GID.locations, SHEET_CONTRACT.locations);
    const locations = rows
      .map((row) => ({
        id: (row.customer_id ?? "").trim(),
        name: (row.customer_name ?? "").trim(),
      }))
      .filter((location) => location.id && location.name);
    return NextResponse.json({ source:"sheet", locations });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
