import { loadConfigFromSheets } from "./config";
import { autoAssignCycle } from "./assign";
import { pushRunLog, type ArmState } from "./smart-log-kv";
import type { LogEntry } from "./types";
import { vnTimestamp } from "./time";
import type { Env } from "./cartrack";

/**
 * Run one assign cycle for the given armed state and persist its logs. Shared by
 * the cron ping and the arm-time first run so the two stay identical.
 */
export async function runArmedCycle(arm: ArmState): Promise<LogEntry[]> {
  let logs: LogEntry[];

  const config = await loadConfigFromSheets();
  if (!config) {
    logs = [{ ts: vnTimestamp(), level: "ERROR", msg: "Failed to load config" }];
  } else {
    logs = await autoAssignCycle(config, arm.env as Env, false);
  }

  // Skip lines an early flush already stored (see assign.ts) — without this the
  // rollover's lines would appear twice in the dashboard log.
  const unflushed = logs.filter((l) => !l.pushed);
  if (unflushed.length) {
    await pushRunLog(unflushed).catch((e) => console.error("[run-cycle] pushRunLog failed:", e));
  }
  return logs;
}
