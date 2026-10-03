import { NextResponse } from "next/server";
import { fetchSheetRows, SHEET_CONTRACT, SHEET_GID } from "@/lib/sheets";
import { masterEnabled } from "@/lib/master-store";
import { sbSelectAll } from "@/lib/supabase-rest";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

/** Use the same profile source as Config; fixed schedules still live in Sheet. */
export async function GET() {
  try {
    if(masterEnabled()) {
      const [rows,drivers]=await Promise.all([
        sbSelectAll<{customer_id:string;customer_name:string}>("master_clients",
          "select=customer_id,customer_name&is_active=eq.true","customer_id.asc"),
        sbSelectAll<{driver_id:string;first_name:string|null;last_name:string|null}>("master_drivers",
          "select=driver_id,first_name,last_name&or=(is_active.is.null,is_active.eq.true)","driver_id.asc")]);
      return NextResponse.json({source:"supabase",locations:rows.filter(r=>r.customer_name?.trim()).map(r=>({id:r.customer_id,name:r.customer_name})),
        drivers:drivers.map(d=>({driver_id:d.driver_id,name:`${d.first_name??""} ${d.last_name??""}`.trim()||d.driver_id}))});
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
