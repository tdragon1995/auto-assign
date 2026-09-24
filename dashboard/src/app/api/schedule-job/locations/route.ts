import { NextResponse } from "next/server";
import { fetchSheetRows, SHEET_CONTRACT, SHEET_GID } from "@/lib/sheets";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

/** The sheet's lookup table is the source of names accepted by Scheduled Setup. */
export async function GET() {
  try {
    const rows = await fetchSheetRows(SHEET_GID.locations, SHEET_CONTRACT.locations);
    const locations = rows
      .map((row) => ({
        id: (row.customer_id ?? "").trim(),
        name: (row.customer_name ?? "").trim(),
      }))
      .filter((location) => location.id && location.name);
    return NextResponse.json({ locations });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
