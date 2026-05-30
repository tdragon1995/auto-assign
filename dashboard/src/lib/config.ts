import type { Config, Mapping } from "./types";
import { fetchSheetRows, fetchSundayMappingRows, SHEET_GID } from "./sheets";
import { vnIsSunday } from "./time";


let cachedConfig: Config | null = null;

export function invalidateConfigCache(): void {
  cachedConfig = null;
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

export async function loadConfigFromSheets(): Promise<Config | null> {
  if (cachedConfig) return cachedConfig;
  try {
    const rows = vnIsSunday()
      ? await fetchSundayMappingRows()
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

    cachedConfig = { mappings };
    return cachedConfig;
  } catch (e) {
    console.error("Error loading config from sheets:", e);
    return null;
  }
}
