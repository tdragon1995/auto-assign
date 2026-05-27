import type { Config, Mapping } from "./types";
import { fetchSheetRows, fetchSundayMappingRows, SHEET_GID } from "./sheets";
import { vnIsSunday } from "./time";

const DEFAULT_JOB_MAX_AGE = 60;

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

export async function loadConfigFromSheets(): Promise<Config | null> {
  if (cachedConfig) return cachedConfig;
  try {
    const rows = vnIsSunday()
      ? await fetchSundayMappingRows()
      : await fetchSheetRows(SHEET_GID.mapping);

    const mappings: Mapping[] = [];
    for (const row of rows) {
      const customer_id = row["customer_id"] ?? "";
      const driver_id = row["driver_id"] ?? "";
      const smart_driver_id = (row["smart_driver_id"] ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean);

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

    cachedConfig = {
      mappings,
      job_max_age_minutes: DEFAULT_JOB_MAX_AGE,
    };
    return cachedConfig;
  } catch (e) {
    console.error("Error loading config from sheets:", e);
    return null;
  }
}
