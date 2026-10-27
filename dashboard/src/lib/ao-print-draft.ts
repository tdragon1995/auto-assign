import { createHash, randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { sharedRedis } from "./redis";
import { printRowKey, type PrintDraftRow, type PrintHistory, type PrintHistorySummary } from "./handover";
import { sbRpc, sbSelect, sbSelectAll } from "./supabase-rest";
import { vnDate } from "./time";

const draftPrefix = (day: string) => `ao:hardcopy:day:${day}:`;
const draftUpdatedAtKey = (day: string) => `ao:hardcopy:updated:${day}`;
const TTL = 7 * 24 * 60 * 60;

export function draftRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? sharedRedis() : null;
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

async function draftKeys(db: Redis, day: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await db.scan(cursor, { match: `${draftPrefix(day)}*`, count: 500 });
    keys.push(...batch);
    if (keys.length > 5000) throw new Error("AO print draft exceeds 5000 rows");
    cursor = String(next);
  } while (cursor !== "0");
  return keys;
}

export async function readPrintDraft(db: Redis, day = vnDate()): Promise<PrintDraftRow[]> {
  const keys = await draftKeys(db, day);
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

export async function readPrintDraftState(db: Redis, day = vnDate()) {
  const [rows, updatedAt] = await Promise.all([readPrintDraft(db, day), db.get<string>(draftUpdatedAtKey(day))]);
  return { rows, updatedAt };
}

export async function savePrintDraft(db: Redis, rows: PrintDraftRow[], day = vnDate()) {
  const unique = new Map(rows.map((r) => [printRowKey(r), r]));
  if (unique.size) {
    const pipe = db.pipeline();
    for (const [key, row] of unique) {
      pipe.set(draftPrefix(day) + createHash("sha256").update(key).digest("hex"), row, { ex: TTL });
    }
    pipe.set(draftUpdatedAtKey(day), new Date().toISOString(), { ex: TTL });
    await pipe.exec();
  }
  return readPrintDraftState(db, day);
}

export async function clearPrintDraft(db: Redis, day = vnDate()) {
  const keys = await draftKeys(db, day);
  for (let i = 0; i < keys.length; i += 200) await db.del(...keys.slice(i, i + 200));
  await db.del(draftUpdatedAtKey(day));
  return readPrintDraftState(db, day);
}

// Lịch sử in lives in Supabase (ao_prints + ao_print_rows), kept 60 days.
const KEEP_DAYS = 60;
interface PrintDb { id: string; printed_at: string; title: string; row_count: number }
const since = () => new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
const summaryOf = (p: PrintDb): PrintHistorySummary => ({ id: p.id, printedAt: p.printed_at, title: p.title, count: p.row_count });

/** Summaries only, newest first; `vid` keeps the prints carrying it (digits, any part). */
export async function listPrints(vid?: string): Promise<PrintHistorySummary[]> {
  const byVid = vid ? `,ao_print_rows!inner()&ao_print_rows.vid=like.*${vid}*` : "";
  const prints = await sbSelect<PrintDb>("ao_prints", `select=id,printed_at,title,row_count${byVid}&printed_at=gte.${since()}&order=printed_at.desc`);
  return prints.map(summaryOf);
}

export async function readPrint(id: string): Promise<PrintHistory | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [print] = await sbSelect<PrintDb>("ao_prints", `select=id,printed_at,title,row_count&id=eq.${id}&printed_at=gte.${since()}`);
  if (!print) return null;
  const rows = await sbSelectAll<PrintDraftRow>("ao_print_rows", `select=dest,client,vid,patient,billing,note&print_id=eq.${id}`, "idx.asc");
  return { id: print.id, printedAt: print.printed_at, title: print.title, rows };
}

/** The browser picks the id so a retried save lands once; ao_save_print never overwrites (and so never erases) a print. */
export async function savePrint(title: string, rows: PrintDraftRow[], id: string = randomUUID()): Promise<PrintHistorySummary> {
  const unique = [...new Map(rows.map((r) => [printRowKey(r), r])).values()];
  return summaryOf(await sbRpc<PrintDb>("ao_save_print", { print_id: id, print_title: title, print_rows: unique }));
}
