import { Redis } from "@upstash/redis";
import type { Config, ConfigDriver, Mapping } from "./types";
import { fetchSheetRows, SHEET_GID } from "./sheets";
import { vnDate, vnIsSunday } from "./time";

function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// Shared invalidation stamp — what makes Refresh reach every instance instead of only the
// one that served it. In-memory caches are per-instance by nature, so the button could
// never clear the others; they kept their copy until they were recycled. Each load now
// compares a few bytes against the stamp its copy was built under and re-reads the sheet
// only when they differ. One tiny GET in place of a ~100 KB CSV download.
const GEN_KEY = "config:gen";
let cachedGen: string | null = null;

/** Current stamp, or null when Redis is unconfigured or unreachable. Null means "no reason
 *  to invalidate", deliberately: a Redis blip that made every instance re-download the
 *  sheet at the same moment is a worse failure than briefly missing a Refresh. */
async function readGen(): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return (await redis.get<string>(GEN_KEY)) ?? null;
  } catch {
    return null;
  }
}

// L2 — the parsed mapping, shared by every instance and every deployment on this Redis.
// GEN_KEY stops an instance serving a STALE copy; it does nothing for a COLD one, which
// still re-downloads and re-parses ~100 KB of CSV before it can assign anything. Running
// the engine from two Vercel projects makes cold starts more frequent, so that download
// is the cost this closes. Mirrors the two-tier cache leave-config.ts already has.
//
// Keyed by gen AND date — both in the key, not compared after the read:
//   gen  — a Refresh moves every instance to a NEW key, so the old blob is orphaned
//          rather than overwritten. There is no window where the stamp reads "new" but
//          the payload is still the old one.
//   date — vnIsSunday() selects a different tab, so a Saturday blob served on Sunday
//          would assign every job from the wrong sheet, silently, all day.
//
// The TTL only reaps orphans (each Refresh strands the previous key). It is never the
// freshness mechanism — that is the gen stamp, deliberately, after a clock-based cache
// was measured at an 87% miss rate.
const L2_TTL_S = 48 * 60 * 60;
const l2Key = (gen: string, date: string) => `config:v1:${gen}:${date}`;


let cachedConfig: Config | null = null;
// The VN date the cached config was built for. NOT a TTL — the cache is held until
// something invalidates it, because a clock-based one was near-useless here: 108 sheet
// downloads for 124 cron cycles over 12h, an 87% miss rate on a 5-minute TTL.
//
// Note WHY a 5-minute TTL missed against a 3-minute cron, since the arithmetic looks like
// it should have hit: the cache is per serverless INSTANCE. Requests spread across several
// instances, so any one instance sees the cron far less often than every 3 minutes and its
// timer has usually lapsed by the time it is called again. No TTL is short enough to fix
// that and long enough to be worth having — the problem was never the duration, it was
// that each instance was alone. GEN_KEY below is the actual fix. A sheet edit is applied
// by the dashboard's Refresh button (invalidateConfigCache), a deliberate act rather than
// something to poll for.
//
// The date is still checked because the mapping SOURCE changes with the day: vnIsSunday()
// picks a different tab, so an instance that cached Saturday's mapping and survived into
// Sunday would assign every job from the wrong sheet, silently and all day. Comparing a
// date string costs nothing and closes that.
//
// Cross-instance invalidation is handled by GEN_KEY above, not by a timer.
let cachedDay = "";

let cachedDrivers: ConfigDriver[] | null = null;
let cachedDriversAt = 0;
const DRIVERS_TTL_MS = 5 * 60 * 1000;

/** Clears this instance AND bumps the shared stamp, so every other warm instance drops its
 *  copy on its next load. Best-effort on the Redis write: a failure degrades to the old
 *  behaviour (this instance only), never to an error. */
export async function invalidateConfigCache(): Promise<void> {
  cachedConfig = null;
  cachedDay = "";
  cachedGen = null;
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(GEN_KEY, String(Date.now()));
  } catch { /* best-effort */ }
}

export function invalidateDriversCache(): void {
  cachedDrivers = null;
  cachedDriversAt = 0;
}

export function parseTime(
  str: string | undefined
): { hours: number; minutes: number } | null {
  if (!str) return null;
  const trimmed = str.trim();
  if (!trimmed) return null;

  // Match HH:MM or HH:MM:SS
  const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  return { hours, minutes };
}

const DRIVER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Driver IDs from the sheet are usable only if they're real UUIDs. Broken
 *  spreadsheet references (#REF!, #N/A, …), blanks, or other junk would build a
 *  malformed assign URL (e.g. PUT /jobs/assign/#REF → Cartrack HTML 404), so we
 *  drop them at load time. */
export function isValidDriverId(id: string): boolean {
  return DRIVER_ID_RE.test(id.trim());
}

/** The Driver tab keeps every driver Cartrack returns, active or not, with the
 *  account flag in `is_active`. A blank (or missing column) counts as active —
 *  the flag is written by the Apps Script fetcher, so if that ever stops running
 *  we want a full picker, not an empty one. Only an explicit false excludes. */
function isDeactivatedRow(row: Record<string, string>): boolean {
  const v = (row["is_active"] ?? "").trim().toLowerCase();
  return v === "false" || v === "0" || v === "no";
}

export async function loadDriversFromSheet(): Promise<ConfigDriver[]> {
  if (cachedDrivers && Date.now() - cachedDriversAt < DRIVERS_TTL_MS) return cachedDrivers;
  try {
    const rows = await fetchSheetRows(SHEET_GID.drivers);
    const drivers: ConfigDriver[] = [];
    let skipped = 0;
    for (const row of rows) {
      const driver_id = (row["delivery_driver_id"] ?? "").trim();
      const name = (row["Driver"] ?? "").trim();
      if (!driver_id) continue;
      // A deactivated account can never take a job — Cartrack 422s the assign
      // ("Driver is deactivated…"). Leaving them in the picker only offers a
      // guaranteed failure, so they're dropped at load time.
      if (isDeactivatedRow(row)) {
        skipped++;
        continue;
      }
      drivers.push({ driver_id, name: name || driver_id });
    }
    console.log(`Loaded ${drivers.length} active drivers from sheet (${skipped} deactivated skipped)`);
    cachedDrivers = drivers.sort((a, b) => a.name.localeCompare(b.name));
    cachedDriversAt = Date.now();
    return cachedDrivers;
  } catch (e) {
    console.error("Error loading drivers from sheet:", e);
    return cachedDrivers || [];
  }
}

export async function loadConfigFromSheets(): Promise<Config | null> {
  const today = vnDate(new Date());
  // Read once and reuse for the write below, so a hit costs exactly one Redis GET.
  const gen = await readGen();
  if (cachedConfig && cachedDay === today && (gen === null || gen === cachedGen)) {
    return cachedConfig;
  }

  // L2 before the sheet: a cold instance pays one small Redis GET instead of the CSV
  // download plus parse. Skipped when gen is null (Redis absent, or a blip) — with no
  // stamp there is no safe key to read under, so fall through to the sheet.
  if (gen !== null) {
    const redis = getRedis();
    if (redis) {
      try {
        const hit = await redis.get<Mapping[]>(l2Key(gen, today));
        // Same zero-length suspicion as the sheet path below: never adopt an empty
        // mapping, whatever it came from.
        if (Array.isArray(hit) && hit.length > 0) {
          cachedConfig = { mappings: hit };
          cachedDay = today;
          cachedGen = gen;
          return cachedConfig;
        }
      } catch { /* fall through to the sheet fetch */ }
    }
  }

  try {
    const rows = vnIsSunday()
      ? await fetchSheetRows(SHEET_GID.sunday)
      : await fetchSheetRows(SHEET_GID.mapping);

    const mappings: Mapping[] = [];
    for (const row of rows) {
      const customer_id = row["customer_id"] ?? "";
      const driver_id = (row["driver_id"] ?? "").trim();
      // Drop junk smart-driver entries (e.g. a broken #REF sheet ref) so they
      // can never build a malformed assign URL. An invalid fixed driver_id is
      // left in place and reported at assign time (assign.ts), where it shows
      // in the Activity Log.
      const smart_driver_id = (row["smart_driver_id"] ?? "")
        .split(",").map((s) => s.trim()).filter(isValidDriverId);

      if (!customer_id || (!driver_id && smart_driver_id.length === 0)) continue;

      mappings.push({
        customer_id,
        driver_id,
        smart_driver_id,
        first_name_last_name: row["first_name_last_name"] ?? "",
        shift_start: parseTime(row["shift_start"]),
        shift_end: parseTime(row["shift_end"]),
        bot_token: row["bot_token"] ?? "",
        chat_id: row["chat_id"] ?? "",
        alt_drop_off_id: row["alt_drop_off_id"] ?? "",
      });
    }

    if (mappings.length === 0) {
      // Zero mappings is almost certainly a bad/empty fetch (there are always
      // hundreds). Don't cache it — keep any prior good cache, else return null so
      // the next cycle retries instead of locking in an empty mapping.
      console.error("Config load returned 0 mappings — not caching");
      return cachedConfig;
    }

    cachedConfig = { mappings };
    cachedDay = today;
    cachedGen = gen;

    // Write-behind, strictly AFTER the zero-mappings guard above. That ordering is the
    // whole safety story: a bad or partial parse cached here would poison every instance
    // on both deployments, where today it only poisons the one that fetched it.
    if (gen !== null) {
      const redis = getRedis();
      if (redis) {
        try {
          await redis.set(l2Key(gen, today), mappings, { ex: L2_TTL_S });
        } catch { /* best-effort; the sheet is always the fallback */ }
      }
    }
    return cachedConfig;
  } catch (e) {
    console.error("Error loading config from sheets:", e);
    // Prefer stale cache over nothing on a transient fetch failure.
    return cachedConfig;
  }
}
