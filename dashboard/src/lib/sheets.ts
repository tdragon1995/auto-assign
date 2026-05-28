const SHEET_ID = "1Bqsm5atLYUQ4gMsL7zHrbrS6YUu7pEDa-Iy_j_wpCss";

export const SHEET_GID = {
  mapping: "0",
  psc: "281585585",
  sunday: "890109864",
  tpl: "934328932",
  schedule_job: "834076876",
} as const;

// Separate spreadsheet used for Sunday driver mappings
const SUNDAY_SHEET_ID = "1AF0Vst3zaXv8U3mi43LIkxCWDFaiYwnHsx1mIgz4JT8";
const SUNDAY_SHEET_GID = "1996956460";

export function sheetCsvUrl(gid: string): string {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
}

export function sundayMappingCsvUrl(): string {
  return `https://docs.google.com/spreadsheets/d/${SUNDAY_SHEET_ID}/export?format=csv&gid=${SUNDAY_SHEET_GID}`;
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

export function parseCSV(text: string): Record<string, string>[] {
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

export async function fetchSheetRows(
  gid: string
): Promise<Record<string, string>[]> {
  const res = await fetch(sheetCsvUrl(gid), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseCSV(await res.text());
}

export async function fetchSundayMappingRows(): Promise<Record<string, string>[]> {
  const res = await fetch(sundayMappingCsvUrl(), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseCSV(await res.text());
}
