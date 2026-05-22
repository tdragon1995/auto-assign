import { NextRequest, NextResponse } from "next/server";
import { getSmartRuns } from "@/lib/smart-log-kv";

export async function GET(req: NextRequest) {
  const limit = Math.min(
    parseInt(req.nextUrl.searchParams.get("limit") ?? "100", 10),
    500
  );
  try {
    const runs = await getSmartRuns(limit);
    return NextResponse.json({ runs });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
