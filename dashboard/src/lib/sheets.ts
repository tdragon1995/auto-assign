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
    // Per-destination routing. Present but blank on every row as of 2026-08-26,
    // so `require` would have been safe today and wrong tomorrow: these are the
    // newest columns in the workbook and the likeliest to be moved or renamed
    // while the feature is still being set up. Expected rather than required
    // until they carry data on every tab that routes.
    expect: ["dropoff_id", "Điểm Drop-off"],
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
} as const satisfies Record<string, { label: string; require: readonly string[]; expect?: readonly string[] }>;

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

/** Alarm label for a tab's soft-column report. Distinct from the tab's own
 *  refusal label so one never clears the other. */
export const expectedColumnAlarm = (sheetLabel: string) => `${sheetLabel} — cột thiếu`;

/**
 * Report — never refuse — columns the code reads but can live without.
 *
 * Called on every checked load, including the clean ones: passing an empty list
 * is what CLEARS a standing warning once the column is put back.
 */
export function noteExpectedHeaders(
  sheetLabel: string,
  headers: string[],
  expected: readonly string[],
): void {
  const present = new Set(headers.map((h) => h.trim()).filter(Boolean));
  const missing = expected.filter((c) => !present.has(c));
  noteSheetWarning(
    expectedColumnAlarm(sheetLabel),
    missing.length === 0 ? null
      : `thiếu cột ${missing.join(", ")} — đọc được nhưng mọi dòng sẽ hiểu là để trống, tính năng dùng cột này lặng lẽ trở về mặc định`,
  );
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
  /**
   * Columns the code READS but can still live without — absence is reported, not
   * refused.
   *
   * This tier exists because `require` cannot express a column that is arriving.
   * A new column starts life absent, so requiring it would refuse the tab on
   * every load from the moment the code ships until someone adds it by hand —
   * which is the footgun that makes the engine run on a stale copy forever. The
   * alternative that has been used so far is to declare nothing at all, and that
   * has the opposite failure: the column silently vanishes, every row reads as
   * blank, the feature quietly reverts to its default, and nothing says so.
   *
   * `expect` is the middle: read it, default it when it is missing, and put a
   * line on the dashboard so a person knows the sheet and the code disagree.
   * Promote to `require` once it is on every tab that needs it and carrying data
   * — `config-audit-live.mts` prints exactly that, so the decision is a look
   * rather than a guess.
   */
  expect?: readonly string[];
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
// Whether this process has looked at the sheets at all, and whether it has said
// so yet. Both are needed to close a hole that change-only publishing has on its
// own: an instance can only CLEAR what it previously set, so once a condition
// goes away while no live instance is holding it, the last published alarm can
// never be retracted by anyone. On 2026-08-31 that left a warning from 10:51 —
// wrong wording, wrong colour, and by then not even true — standing on the
// dashboard across four deploys, because every fresh instance found nothing
// wrong and therefore said nothing.
//
// So the first report from each process is unconditional: it states the truth
// even when the truth is "nothing". After that, change-only resumes. One extra
// write per instance lifetime, not per cycle.
let sheetsChecked = false;
let publishedOnce = false;

/** Record the outcome of a load. Pass the error when a tab was refused, or null
 *  when it read cleanly, which clears any standing alarm for it. Callers that
 *  served a cached copy without re-reading must call NEITHER — nothing was
 *  checked, so nothing is known. */
export function noteSheetLoad(label: string, err: SheetShapeError | null): void {
  sheetsChecked = true;
  if (err) {
    sheetAlarms.set(label, { kind: "refused", label, reason: err.reason, ts: vnTimestamp() });
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
  sheetsChecked = true;
  if (reason) {
    const prev = sheetWarnings.get(label);
    if (prev?.reason === reason) return;   // same complaint, already standing
    sheetWarnings.set(label, { kind: "data", label, reason, ts: vnTimestamp() });
    sheetAlarmsChanged = true;
  } else if (sheetWarnings.delete(label)) {
    sheetAlarmsChanged = true;
  }
}

/** The current set, or null when nothing has changed since the last drain — the
 *  cycle then leaves the published field untouched rather than rewriting it. */
export function drainSheetAlarms(): SheetAlarm[] | null {
  // The first report from a process goes out even when nothing changed — that is
  // what retracts an alarm nobody alive is holding any more. Gated on having
  // actually looked, so an instance that has not read a sheet yet cannot publish
  // an empty set over a real one.
  const firstReport = sheetsChecked && !publishedOnce;
  if (!sheetAlarmsChanged && !firstReport) return null;
  sheetAlarmsChanged = false;
  publishedOnce = true;
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
  if (opts.expect) noteExpectedHeaders(label, headers, opts.expect);
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
  if (opts.expect) noteExpectedHeaders(label, headers, opts.expect);
  return rows;
}

