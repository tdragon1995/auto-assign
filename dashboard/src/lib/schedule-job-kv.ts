import { Redis } from "@upstash/redis";
import type { ScheduleJobResult } from "./schedule-job";

const KEY_LAST_RUN = "schedule_job:last_run";
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function getRedis() {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export interface ScheduleRunRecord {
  ts: string;             // ISO timestamp of run completion
  date: string;           // VN date (YYYY-MM-DD) the run targets
  weekday: number;        // 0=Sun..6=Sat
  trigger: "cron" | "manual" | "retry";
  results: ScheduleJobResult[];
}

export async function saveLastRun(record: ScheduleRunRecord): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(KEY_LAST_RUN, JSON.stringify(record), { ex: TTL_SECONDS });
}

export async function getLastRun(): Promise<ScheduleRunRecord | null> {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get<string | ScheduleRunRecord>(KEY_LAST_RUN);
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw) as ScheduleRunRecord; } catch { return null; }
}
