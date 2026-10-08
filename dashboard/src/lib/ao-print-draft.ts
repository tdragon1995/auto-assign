import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import { printRowKey, type PrintDraftRow } from "./handover";

const PREFIX = "ao:hardcopy:print:";
const TTL = 7 * 24 * 60 * 60;

export function draftRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

export function printRowOf(value: unknown): PrintDraftRow | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const limits: Record<keyof PrintDraftRow, number> = {
    dest: 32, client: 300, vid: 32, patient: 300, billing: 500, note: 1000,
  };
  if (!Object.entries(limits).every(([field, max]) => typeof r[field] === "string" && (r[field] as string).length <= max)
    || !/^\d{8,32}$/.test(r.vid as string)) return null;
  return { dest: r.dest as string, client: r.client as string, vid: r.vid as string,
    patient: r.patient as string, billing: r.billing as string, note: r.note as string };
}

export async function readPrintDraft(db: Redis): Promise<PrintDraftRow[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await db.scan(cursor, { match: `${PREFIX}*`, count: 500 });
    keys.push(...batch);
    if (keys.length > 5000) throw new Error("AO print draft exceeds 5000 rows");
    cursor = String(next);
  } while (cursor !== "0");

  const rows: PrintDraftRow[] = [];
  for (let i = 0; i < keys.length; i += 200) {
    const values = await db.mget<(PrintDraftRow | string | null)[]>(...keys.slice(i, i + 200));
    for (const value of values) {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      const row = printRowOf(parsed);
      if (row) rows.push(row);
    }
  }
  return rows;
}

export async function savePrintDraft(db: Redis, rows: PrintDraftRow[]): Promise<PrintDraftRow[]> {
  const unique = new Map(rows.map((r) => [printRowKey(r), r]));
  if (unique.size) {
    const pipe = db.pipeline();
    for (const [key, row] of unique) {
      pipe.set(PREFIX + createHash("sha256").update(key).digest("hex"), row, { ex: TTL });
    }
    await pipe.exec();
  }
  return readPrintDraft(db);
}
