import type { Config, Mapping } from "./types";

const SHEET_ID = "1Bqsm5atLYUQ4gMsL7zHrbrS6YUu7pEDa-Iy_j_wpCss";
const PSC_SHEET_GID = "281585585";
const SUNDAY_SHEET_GID = "890109864";
const MAPPING_SHEET_GID = "0";
const PSC_SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${PSC_SHEET_GID}`;
const MAPPING_SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${MAPPING_SHEET_GID}`;
const SUNDAY_SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SUNDAY_SHEET_GID}`;


const DEFAULT_POLL_INTERVAL = 30;
const DEFAULT_JOB_MAX_AGE = 60;




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

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function parseCSV(text: string): Record<string, string>[] {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]).map((h) => h.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] ?? "").trim();
    });
    rows.push(row);
  }
  return rows;
}

export async function loadConfigFromSheets(): Promise<Config | null> {
  try {
    const res = await fetch(MAPPING_SHEET_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();
    const rows = parseCSV(text);

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

    return {
      mappings,
      poll_interval_seconds: DEFAULT_POLL_INTERVAL,
      job_max_age_minutes: DEFAULT_JOB_MAX_AGE,
    };
  } catch (e) {
    console.error("Error loading config from sheets:", e);
    return null;
  }
}
