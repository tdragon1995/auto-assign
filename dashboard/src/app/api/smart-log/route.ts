import { NextRequest, NextResponse } from "next/server";
import { getSmartRuns } from "@/lib/smart-log-kv";

export async function GET(req: NextRequest) {
  const limit = Math.min(
    parseInt(req.nextUrl.searchParams.get("limit") ?? "100", 10),
    500
  );

  const configured = !!(
    (process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL) &&
    (process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN)
  );

  try {
    const runs = await getSmartRuns(limit);
    return NextResponse.json({ configured, runs });
  } catch (e) {
    return NextResponse.json({ configured, error: String(e) }, { status: 500 });
  }
}
