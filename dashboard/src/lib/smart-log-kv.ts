import { kv } from "@vercel/kv";
import type { LogEntry } from "./types";

const KV_KEY = "smart:runs";
const MAX_RUNS = 500;

export interface SmartRunEntry {
  ts: string;
  ok: number;
  warn: number;
  error: number;
  entries: LogEntry[];
}

function isSmartLog(entry: LogEntry): boolean {
  return entry.msg.includes("SMART") || entry.msg.includes("Smart-assign");
}

/** Persist smart-assign log entries from a completed assign cycle. */
export async function pushSmartRun(allLogs: LogEntry[]): Promise<void> {
  const entries = allLogs.filter(isSmartLog);
  if (entries.length === 0) return;

  const run: SmartRunEntry = {
    ts: entries[0].ts,
    ok:    entries.filter((e) => e.level === "OK").length,
    warn:  entries.filter((e) => e.level === "WARN").length,
    error: entries.filter((e) => e.level === "ERROR").length,
    entries,
  };

  await kv.lpush(KV_KEY, JSON.stringify(run));
  await kv.ltrim(KV_KEY, 0, MAX_RUNS - 1);
}

/** Read the most recent N runs (default 100). */
export async function getSmartRuns(limit = 100): Promise<SmartRunEntry[]> {
  const raw = await kv.lrange<string>(KV_KEY, 0, limit - 1);
  return raw.map((r) => (typeof r === "string" ? JSON.parse(r) : r) as SmartRunEntry);
}
