import { NextRequest, NextResponse } from "next/server";
import { loadConfigFromSheets } from "@/lib/config";
import { autoAssignCycle } from "@/lib/assign";
import type { Env } from "@/lib/cartrack";
import { pushSmartRun, touchLastRun, getLastRunTs } from "@/lib/smart-log-kv";

export async function GET() {
  const lastRunTs = await getLastRunTs();
  return NextResponse.json({ lastRunTs });
}

export async function POST(req: NextRequest) {
  touchLastRun().catch(() => {});
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const skipSmart = req.nextUrl.searchParams.get("skipSmart") === "1";
  try {
    const config = await loadConfigFromSheets();
    if (!config) {
      return NextResponse.json(
        { logs: [{ ts: new Date().toISOString(), level: "ERROR", msg: "Failed to load config" }] },
        { status: 500 }
      );
    }

    const logs = await autoAssignCycle(config, env, skipSmart);
    // Fire-and-forget: don't let KV failures block the response
    pushSmartRun(logs).catch(() => {});
    return NextResponse.json({ logs });
  } catch (e) {
    return NextResponse.json(
      { logs: [{ ts: new Date().toISOString(), level: "ERROR", msg: String(e) }] },
      { status: 500 }
    );
  }
}
