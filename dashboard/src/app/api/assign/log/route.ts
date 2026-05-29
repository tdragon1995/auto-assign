import { NextRequest, NextResponse } from "next/server";
import { getRunLog } from "@/lib/smart-log-kv";

/** Server-backed live log for the dashboard ticker. */
export async function GET(req: NextRequest) {
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "300", 10), 500);
  try {
    const logs = await getRunLog(limit);
    return NextResponse.json({ logs });
  } catch (e) {
    return NextResponse.json({ logs: [], error: String(e) }, { status: 500 });
  }
}
