import type { SheetAlarm } from "./types";
import { vnTimestamp } from "./time";

export const SHEET_ID = "1Bqsm5atLYUQ4gMsL7zHrbrS6YUu7pEDa-Iy_j_wpCss";

export const SHEET_GID = {
  mapping: "0",
  psc: "281585585",
  sunday: "1277313355",
  tpl: "934328932",
  schedule_job: "834076876",
  nghi_phep: "158238549",
  drivers: "467715355",
  // Read by the location audit only. The engine never reads this tab — it sees
  // only the branch ids the workbook's own lookup already resolved — which is
  // exactly why a duplicate name here goes unnoticed until a pickup fails.
  locations: "232994825",
} as const;

/**
 * What each tab must still look like for its reader to trust it.
 *
 * `require` lists only columns whose ABSENCE would change behaviour silently —
 * not every column read. A missing `shift_start` is in here because it would
 * quietly turn every rule into an all-day one; `bot_token` is not, because its
 * absence only costs a notification, and the Sunday tab genuinely does not have
 * it.
 *
 * Verified against the live workbook on 2026-08-24. Anything added here must be
 * checked against the live header row first: requiring a column that is not
 * there refuses the tab on every load, and the engine would then run on a stale
 * copy indefinitely.
 */
export const SHEET_CONTRACT = {
  mapping: {
    label: "config (mapping)",
    require: ["customer_id", "driver_id", "smart_driver_id", "Driver", "shift_start", "shift_end"],
  },
  sunday: {
    label: "CONFIG SUNDAY",
    require: ["customer_id", "driver_id", "smart_driver_id", "Driver", "shift_start", "shift_end"],
  },
  drivers: {
    label: "Driver (roster)",
    require: ["Driver", "delivery_driver_id", "is_active"],
  },
  nghi_phep: {
    label: "Leave Status (nghỉ phép)",
    require: ["driver_id", "driver", "Loại Nghỉ", "leave_from", "leave_to", "leave_from_hr", "leave_to_hr"],
  },
  tpl: {
    label: "3PL",
    require: ["psc-tinh", "3pl", "3pl_uuid", "address"],
  },
  schedule_job: {
    label: "Scheduled Setup",
    require: ["pickup_id", "dropoff_id", "delivery_windows", "reference"],
  },
  public_sunday: {
    label: "PUBLIC SUNDAY SCHEDULE",
    require: ["Ngày làm việc", "STT", "Họ và tên", "Địa điểm", "Ca"],
  },
  locations: {
    label: "Location Table",
    require: ["customer_name", "customer_id"],
  },
} as const satisfies Record<string, { label: string; require: readonly string[] }>;

export function sheetCsvUrl(gid: string): string {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
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

export function parseCSVWithHeaders(
  text: string
): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

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
  return { headers, rows };
}

export function parseCSV(text: string): Record<string, string>[] {
  return parseCSVWithHeaders(text).rows;
}

/**
 * A load whose SHAPE is wrong: the response was not CSV at all, or it was
 * missing a column the reader cannot work without.
 *
 * Deliberately distinct from a network failure. Both make a caller keep its last
 * good copy, but only this one means the spreadsheet has been edited into a
 * state the engine cannot read — which is a person to tell, not a request to
 * retry. `assign.ts` turns it into an entry in the "Cần xử lý" tab.
 */
export class SheetShapeError extends Error {
  /** Tag rather than relying on `instanceof`, which does not survive every
   *  bundling boundary. */
  readonly kind = "sheet-shape" as const;
  constructor(readonly sheetLabel: string, readonly reason: string) {
    super(`${sheetLabel}: ${reason}`);
    this.name = "SheetShapeError";
  }
}

export function isSheetShapeError(e: unknown): e is SheetShapeError {
  return !!e && typeof e === "object" && (e as { kind?: string }).kind === "sheet-shape";
}

/**
 * Refuse a parse that is missing any column its reader needs.
 *
 * One check catches three separate accidents:
 *   - a column renamed or deleted by hand;
 *   - an error page served with HTTP 200, whose "headers" parse as markup;
 *   - the by-name lookup being answered with the WRONG TAB. Google answers an
 *     unknown sheet name with the FIRST tab in the workbook rather than an
 *     error, and in this workbook that is the ~1,700-row mapping table — which
 *     parses perfectly and means something else entirely.
 *
 * Exported because `leave-config.ts` builds its own URL and runs its own
 * tokenizer (its note cells contain line breaks inside quotes), so it cannot go
 * through `fetchSheetRows` but still needs the same contract.
 */
export function assertHeaders(
  sheetLabel: string,
  headers: string[],
  required: readonly string[]
): void {
  const present = new Set(headers.map((h) => h.trim()).filter(Boolean));
  const missing = required.filter((r) => !present.has(r));
  if (missing.length > 0) {
    throw new SheetShapeError(sheetLabel, `thiếu cột ${missing.join(", ")}`);
  }
}

/** Google serves its CSV export as text/csv; a permissions or redirect page
 *  comes back as HTML, sometimes with a 200. Checked only when the header is
 *  present and explicitly says HTML, so a missing content-type never fails a
 *  load that would otherwise have worked.
 *
 *  Exported for `leave-config.ts`, which fetches for itself. */
export function assertCsvResponse(sheetLabel: string, res: Response): void {
  const ct = res.headers.get("content-type") ?? "";
  if (/html/i.test(ct)) {
    throw new SheetShapeError(sheetLabel, "Google trả về trang HTML thay vì CSV (quyền truy cập?)");
  }
}

export interface SheetFetchOptions {
  /** Columns the caller cannot work without. Omit to skip the contract. */
  require?: readonly string[];
  /** Human name for the tab, shown in the alarm. */
  label?: string;
}

// ── Which tabs are currently unreadable ──────────────────────────────────────
//
// Per-instance on purpose, and that is enough: the assign cycle runs the readers
// and publishes the snapshot in the SAME invocation, so this map is always the
// view of the instance that just did the loading.
//
// Reported only when it CHANGES (`drainSheetAlarms`), so a healthy fleet writes
// nothing at all. That matters — the key-value plan is billed per command and is
// already projected over its monthly free allowance, so a per-cycle write for a
// condition that is almost always "fine" is exactly what not to add.
const sheetAlarms = new Map<string, SheetAlarm>();
// Kept apart from the refusals above because they answer different questions.
// "Is this tab readable?" has to be answerable on its own — the contract check
// that runs against the live workbook passes or fails on THAT alone, and a tab
// that reads perfectly while carrying a bad row must not be able to fail it.
// Both still reach the dashboard together: one banner, two kinds of trouble.
const sheetWarnings = new Map<string, SheetAlarm>();
let sheetAlarmsChanged = false;

/** Record the outcome of a load. Pass the error when a tab was refused, or null
 *  when it read cleanly, which clears any standing alarm for it. Callers that
 *  served a cached copy without re-reading must call NEITHER — nothing was
 *  checked, so nothing is known. */
export function noteSheetLoad(label: string, err: SheetShapeError | null): void {
  if (err) {
    sheetAlarms.set(label, { label, reason: err.reason, ts: vnTimestamp() });
    sheetAlarmsChanged = true;
  } else if (sheetAlarms.delete(label)) {
    sheetAlarmsChanged = true;
  }
}

/**
 * Record a tab that READ cleanly but whose CONTENT is wrong — a lookup that no
 * longer resolves, a name that means two different places.
 *
 * Separate entry point from `noteSheetLoad` because the two say different things
 * and must not overwrite each other: a tab can be perfectly readable and still be
 * carrying rows the engine cannot use. Keyed by a distinct label per warning so
 * one clearing does not silence the other.
 *
 * Pass null to clear, exactly like a clean load. Same change-only publishing, so
 * a healthy day still writes nothing.
 */
export function noteSheetWarning(label: string, reason: string | null): void {
  if (reason) {
    const prev = sheetWarnings.get(label);
    if (prev?.reason === reason) return;   // same complaint, already standing
    sheetWarnings.set(label, { label, reason, ts: vnTimestamp() });
    sheetAlarmsChanged = true;
  } else if (sheetWarnings.delete(label)) {
    sheetAlarmsChanged = true;
  }
}

/** The current set, or null when nothing has changed since the last drain — the
 *  cycle then leaves the published field untouched rather than rewriting it. */
export function drainSheetAlarms(): SheetAlarm[] | null {
  if (!sheetAlarmsChanged) return null;
  sheetAlarmsChanged = false;
  // Refused tabs first: a tab the engine cannot read at all outranks a tab it
  // can read but should not trust.
  return [...sheetAlarms.values(), ...sheetWarnings.values()];
}

/** Only the tabs that could not be READ. Separate from the drain because the
 *  live contract check asks exactly this and nothing else, and because draining
 *  would clear the state the cycle still needs to publish. */
export function currentSheetRefusals(): SheetAlarm[] {
  return [...sheetAlarms.values()];
}

export async function fetchSheetRows(
  gid: string,
  opts: SheetFetchOptions = {}
): Promise<Record<string, string>[]> {
  // `cache: "no-store"` only bypasses our/Next's fetch cache — Google's CDN still serves a
  // cached copy of the export URL for several minutes. A unique cache-busting param makes the
  // CDN treat each request as a new URL and regenerate, so we always read the live sheet.
  const url = `${sheetCsvUrl(gid)}&_cb=${Date.now()}`;
  const label = opts.label ?? `tab gid ${gid}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  assertCsvResponse(label, res);
  const { headers, rows } = parseCSVWithHeaders(await res.text());
  if (opts.require) assertHeaders(label, headers, opts.require);
  return rows;
}

/** Fetch a tab by its visible name (gviz CSV endpoint) instead of gid. Useful for
 *  display-only sheets whose gid isn't tracked in SHEET_GID and may be re-created. */
export function gvizCsvUrl(sheetName: string): string {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(sheetName)}`;
}

export async function fetchSheetRowsByName(
  sheetName: string,
  opts: SheetFetchOptions = {}
): Promise<Record<string, string>[]> {
  const url = `${gvizCsvUrl(sheetName)}&_cb=${Date.now()}`;
  const label = opts.label ?? sheetName;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  assertCsvResponse(label, res);
  const { headers, rows } = parseCSVWithHeaders(await res.text());
  // Load-bearing here rather than merely defensive: this endpoint answers an
  // unknown tab name with the first tab in the workbook, so without a contract a
  // renamed tab reads as perfectly good data from somewhere else.
  if (opts.require) assertHeaders(label, headers, opts.require);
  return rows;
}

