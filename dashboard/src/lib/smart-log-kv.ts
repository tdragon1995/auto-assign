import { Redis } from "@upstash/redis";
import type { LogEntry } from "./types";

const KV_KEY = "smart:runs";
const MAX_RUNS = 500;

const LAST_ASSIGN_KEY = "assign:last_run_ts";

function getRedis() {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

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
  const redis = getRedis();
  if (!redis) return;

  const entries = allLogs.filter(isSmartLog);
  if (entries.length === 0) return;

  const run: SmartRunEntry = {
    ts:    entries[0].ts,
    ok:    entries.filter((e) => e.level === "OK").length,
    warn:  entries.filter((e) => e.level === "WARN").length,
    error: entries.filter((e) => e.level === "ERROR").length,
    entries,
  };

  await redis.lpush(KV_KEY, JSON.stringify(run));
  await redis.ltrim(KV_KEY, 0, MAX_RUNS - 1);
}

export interface LastRunEntry {
  ts: string;
  tabId: string;
}

/** Record that /api/assign was just called by tabId (fire-and-forget safe). */
export async function touchLastRun(tabId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const entry: LastRunEntry = { ts: new Date().toISOString(), tabId };
  await redis.set(LAST_ASSIGN_KEY, JSON.stringify(entry), { ex: 600 });
}

/** Return the last /api/assign entry, or null. */
export async function getLastRunEntry(): Promise<LastRunEntry | null> {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get<string | LastRunEntry>(LAST_ASSIGN_KEY);
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw) as LastRunEntry; } catch { return null; }
}

/** Read the most recent N runs (default 100). */
export async function getSmartRuns(limit = 100): Promise<SmartRunEntry[]> {
  const redis = getRedis();
  if (!redis) return [];

  const raw = await redis.lrange<string>(KV_KEY, 0, limit - 1);
  return raw.map((r) => (typeof r === "string" ? JSON.parse(r) : r) as SmartRunEntry);
}
