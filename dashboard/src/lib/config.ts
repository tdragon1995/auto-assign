import type { Config, ConfigDriver, Mapping } from "./types";
import { fetchSheetRows, SHEET_GID } from "./sheets";
import { vnIsSunday } from "./time";


let cachedConfig: Config | null = null;
let cachedAt = 0;
// Re-fetch after this long so a sheet edit (and the Sat→Sun mapping switch) self-heals
// without a redeploy. Each serverless instance caches independently, so without a TTL a
// stale load (e.g. a transiently empty Sunday read) would persist for that instance's life.
const CONFIG_TTL_MS = 5 * 60 * 1000;

export function invalidateConfigCache(): void {
  cachedConfig = null;
  cachedAt = 0;
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

/** Deduplicated driver list from the config: the union of every valid fixed
 *  driver_id and smart_driver_id across all mappings. Names come from a fixed
 *  row's first_name_last_name; a smart-only driver with no fixed row anywhere
 *  falls back to its UUID. Sorted by display name. No network — derived from the
 *  already-loaded (cached) config, so the manual-assign picker costs nothing. */
export function driversFromConfig(config: Config): ConfigDriver[] {
  const nameById = new Map<string, string>();
  const allIds = new Set<string>();
  for (const m of config.mappings) {
    if (m.driver_id && isValidDriverId(m.driver_id)) {
      allIds.add(m.driver_id);
      const name = m.first_name_last_name.trim();
      if (name && !nameById.has(m.driver_id)) nameById.set(m.driver_id, name);
    }
    for (const sid of m.smart_driver_id) allIds.add(sid);
  }
  return [...allIds]
    .map((driver_id) => ({ driver_id, name: nameById.get(driver_id) || driver_id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadConfigFromSheets(): Promise<Config | null> {
  if (cachedConfig && Date.now() - cachedAt < CONFIG_TTL_MS) return cachedConfig;
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
    cachedAt = Date.now();
    return cachedConfig;
  } catch (e) {
    console.error("Error loading config from sheets:", e);
    // Prefer stale cache over nothing on a transient fetch failure.
    return cachedConfig;
  }
}
