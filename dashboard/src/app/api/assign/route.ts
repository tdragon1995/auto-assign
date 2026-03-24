import { NextRequest, NextResponse } from "next/server";
import { loadConfigFromSheets } from "@/lib/config";
import { autoAssignCycle } from "@/lib/assign";
import type { Env } from "@/lib/cartrack";

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  try {
    const config = await loadConfigFromSheets();
    if (!config) {
      return NextResponse.json(
        { logs: [{ ts: new Date().toISOString(), level: "ERROR", msg: "Failed to load config" }] },
        { status: 500 }
      );
    }

    const logs = await autoAssignCycle(config, env);
    return NextResponse.json({ logs });
  } catch (e) {
    return NextResponse.json(
      { logs: [{ ts: new Date().toISOString(), level: "ERROR", msg: String(e) }] },
      { status: 500 }
    );
  }
}
