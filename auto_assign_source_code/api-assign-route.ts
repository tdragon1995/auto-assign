import { NextRequest, NextResponse } from "next/server";
import { loadConfigFromSheets } from "@/lib/config";
import { autoAssignCycle } from "@/lib/assign";
import type { Env } from "@/lib/cartrack";
import { vnTimestamp } from "@/lib/time";
import { pushSmartRun, touchLastRun, getLastRunEntry } from "@/lib/smart-log-kv";

export async function GET() {
  const entry = await getLastRunEntry();
  return NextResponse.json({ lastRunTs: entry?.ts ?? null, tabId: entry?.tabId ?? null });
}

export async function POST(req: NextRequest) {
  const tabId = req.nextUrl.searchParams.get("tab") ?? "unknown";
  touchLastRun(tabId).catch(() => {});
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const skipSmart = req.nextUrl.searchParams.get("skipSmart") === "1";
  try {
    const config = await loadConfigFromSheets();
    if (!config) {
      return NextResponse.json(
        { logs: [{ ts: vnTimestamp(), level: "ERROR", msg: "Failed to load config" }] },
        { status: 500 }
      );
    }

    const logs = await autoAssignCycle(config, env, skipSmart);
    try {
      await pushSmartRun(logs);
    } catch (e) {
      logs.push({ ts: vnTimestamp(), level: "WARN", msg: `Smart-log KV write failed: ${e}` });
    }
    return NextResponse.json({ logs });
  } catch (e) {
    return NextResponse.json(
      { logs: [{ ts: vnTimestamp(), level: "ERROR", msg: String(e) }] },
      { status: 500 }
    );
  }
}
