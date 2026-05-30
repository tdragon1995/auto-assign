import { loadConfigFromSheets } from "./config";
import { autoAssignCycle } from "./assign";
import { pushSmartRun, pushRunLog, type ArmState } from "./smart-log-kv";
import type { LogEntry } from "./types";
import type { Env } from "./cartrack";

/**
 * Run one assign cycle for the given armed state (smart or auto-plan) and
 * persist its logs. Shared by the cron ping and the arm-time first run so the
 * two stay identical. `origin` is only used to reach /api/autoplan.
 */
export async function runArmedCycle(arm: ArmState, origin: string): Promise<LogEntry[]> {
  let logs: LogEntry[] = [];

  if (arm.mode === "autoplan") {
    const res = await fetch(`${origin}/api/autoplan?env=${arm.env}`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    logs = (data.logs as LogEntry[]) ?? [];
  } else {
    const config = await loadConfigFromSheets();
    if (!config) {
      logs = [{ ts: new Date().toISOString(), level: "ERROR", msg: "Failed to load config" }];
    } else {
      logs = await autoAssignCycle(config, arm.env as Env, false);
      await pushSmartRun(logs).catch((e) => console.error("[run-cycle] pushSmartRun failed:", e));
    }
  }

  await pushRunLog(logs).catch((e) => console.error("[run-cycle] pushRunLog failed:", e));
  return logs;
}
