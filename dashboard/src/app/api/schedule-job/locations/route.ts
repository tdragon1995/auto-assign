import { NextResponse } from "next/server";
import { masterChoices } from "@/lib/master-choices";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

/** Use the same profile source as Config. */
export async function GET() {
  try {
    const {locations,drivers}=await masterChoices();
    return NextResponse.json({source:"supabase",locations,drivers},{headers:{"Cache-Control":"no-store"}});
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
