/**
 * The roster grid — which shift a driver was rostered for, on a given date.
 *
 * THIS IS THE ONLY SOURCE OF A SHIFT. The payroll workbook resolves one through
 * Sunday roster → substitution → a standing weekly contract ("Ca làm"); that
 * chain is being retired and must not be reproduced. Sunday rows and
 * substitutions are maintained in this grid, so a shift is one lookup:
 *
 *     shift = grid[staff code][date]
 *
 * SHAPE. One row per driver, one COLUMN PER DATE, headed `d/M` with no year:
 *
 *     Nhân viên        | Mã NV    | Nguồn | 1/8        | 2/8 | 3/8        | …
 *     Bùi Đình Phát    | DC100528 | MISA  | 6:00-15:00 |     | 6:00-15:00 | …
 *
 * A cell is a window (`6:00-15:00`), or `P` (phép), `Quốc khánh`, or blank for a
 * day not worked. Only a window is a shift; everything else means the driver was
 * not rostered, which is NOT the same as "no data" — see `ShiftLookup.reason`.
 *
 * WHY THE COLUMNS CARRY NO YEAR. They are a rolling two-month window maintained
 * by hand, so `1/8` is unambiguous in context and ambiguous in code. Each column
 * is resolved to whichever year puts it CLOSEST TO TODAY, which is correct
 * across a December→January boundary in both directions and needs no extra
 * column in the sheet.
 *
 * MEASURED, before this was wired. Against the payroll workbook over 1–14/08, on
 * the 338 driver-days where the grid has a window: 80.2% exact, 90% within 15
 * minutes, and −3.3% on the total. The days it does NOT cover were excluded
 * rather than guessed, which is the whole point — a tap-to-tap fallback pays Lê
 * Hoàng Anh Duy 12.83 h against a 3.5 h shift.
 */
import { fetchSheetRows, SHEET_GID } from "./sheets";
import { vnDate } from "./time";

export interface GridShift {
  /** "HH:MM" local, VN. */
  start: string;
  end: string;
}

export type ShiftMiss =
  /** The grid has a row for this driver but the cell is empty — a day off. */
  | "day-off"
  /** The cell says `P`, `Quốc khánh` or similar: rostered off, not working. */
  | "not-working"
  /** No row for this staff code at all. Includes the FT-overflow accounts,
   *  which are rostered under their `DC…` twin and so have no PT row. */
  | "no-driver-row"
  /** The date is outside the grid's columns entirely. */
  | "date-not-covered";

export interface ShiftLookup {
  shift: GridShift | null;
  reason: ShiftMiss | null;
  /** Verbatim cell text when there was one — so a fault report can say WHAT the
   *  sheet said rather than only that it said nothing useful. */
  cell: string | null;
}

export interface ShiftGrid {
  /** `${staffCode}|${YYYY-MM-DD}` → the cell. */
  cells: Map<string, string>;
  /** Staff codes that have a row, so "no row" is distinguishable from "blank". */
  drivers: Set<string>;
  /** Dates the grid has columns for. */
  dates: Set<string>;
  fetchedAt: number;
}

const WINDOW = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/;
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * `"1/8"` → `"2026-08-01"`, choosing the year that lands CLOSEST to `today`.
 *
 * Tries last year, this year and next year and keeps the nearest. On a grid
 * maintained two months either side of now that is unambiguous, and it is the
 * only rule that survives December→January without a year in the header.
 */
export function resolveGridDate(header: string, today: string): string | null {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(header);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  const nowMs = Date.parse(`${today}T00:00:00Z`);
  const thisYear = Number(today.slice(0, 4));
  let best: string | null = null;
  let bestGap = Infinity;
  for (const y of [thisYear - 1, thisYear, thisYear + 1]) {
    const iso = `${y}-${pad(month)}-${pad(day)}`;
    const ms = Date.parse(`${iso}T00:00:00Z`);
    if (!Number.isFinite(ms)) continue;
    // Reject a date the calendar does not have (31/2 becomes 3/3 otherwise).
    if (new Date(ms).getUTCDate() !== day) continue;
    const gap = Math.abs(ms - nowMs);
    if (gap < bestGap) { bestGap = gap; best = iso; }
  }
  return best;
}

/** Parse one cell. Only a `H:MM-H:MM` window is a shift. */
export function parseGridCell(cell: string): GridShift | null {
  const m = WINDOW.exec(cell ?? "");
  if (!m) return null;
  const h1 = Number(m[1]), h2 = Number(m[3]);
  if (h1 > 23 || h2 > 23) return null;
  return { start: `${pad(h1)}:${m[2]}`, end: `${pad(h2)}:${m[4]}` };
}

/** Look one driver-day up, saying WHY when there is no shift. The reason is what
 *  a fault report shows; it is never a licence to fall back to the taps. */
export function lookupShift(grid: ShiftGrid, staffCode: string | null, date: string): ShiftLookup {
  if (!staffCode) return { shift: null, reason: "no-driver-row", cell: null };
  if (!grid.dates.has(date)) return { shift: null, reason: "date-not-covered", cell: null };
  if (!grid.drivers.has(staffCode)) return { shift: null, reason: "no-driver-row", cell: null };
  const cell = grid.cells.get(`${staffCode}|${date}`) ?? "";
  const shift = parseGridCell(cell);
  if (shift) return { shift, reason: null, cell };
  return { shift: null, reason: cell.trim() ? "not-working" : "day-off", cell: cell || null };
}

/** Rows in, grid out. Split from the fetch so the parse is testable offline. */
export function buildShiftGrid(rows: Record<string, string>[], today = vnDate()): ShiftGrid {
  const cells = new Map<string, string>();
  const drivers = new Set<string>();
  const dates = new Set<string>();
  // Header → ISO date, resolved once rather than per cell.
  const dateCols = new Map<string, string>();
  for (const key of Object.keys(rows[0] ?? {})) {
    const iso = resolveGridDate(key, today);
    if (iso) { dateCols.set(key, iso); dates.add(iso); }
  }
  for (const row of rows) {
    const code = (row["Mã NV"] ?? "").trim();
    // The sheet's second row is the weekday strip (T7, CN, …) and carries no
    // code, so this drops it without needing to know it is there.
    if (!code) continue;
    drivers.add(code);
    for (const [key, iso] of dateCols) {
      const v = (row[key] ?? "").trim();
      if (v) cells.set(`${code}|${iso}`, v);
    }
  }
  return { cells, drivers, dates, fetchedAt: Date.now() };
}

// The grid changes when someone edits the roster — a few times a week at most —
// and every pay read wants the whole thing, so it is cached for the same reason
// the config is. Deliberately NOT on the assign cycle's path: nothing in the
// engine reads it.
const TTL_MS = 10 * 60 * 1000;
let cached: ShiftGrid | null = null;

export function invalidateShiftGrid(): void { cached = null; }

export async function loadShiftGrid(fresh = false): Promise<ShiftGrid> {
  if (!fresh && cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
  const rows = await fetchSheetRows(SHEET_GID.shift_grid, {
    label: "Shift grid (bảng công)",
    // `require` names only what identifies a row. The date columns are the
    // POINT of this tab but they are named `d/M` and rotate every month, so
    // requiring any of them would refuse the tab the moment the window moved.
    require: ["Nhân viên", "Mã NV"],
  });
  cached = buildShiftGrid(rows);
  return cached;
}
