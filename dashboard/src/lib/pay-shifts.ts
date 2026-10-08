/**
 * Payroll's monthly records file → shift rows for pay_shifts.
 *
 * The file ("…_Parttime Records.xlsx", sheet "Details") is what payroll pays
 * against: one row per driver per shift window, with the account, the date and
 * "Ca vào" / "Ca ra". Its recorded in/out and hours columns are payroll's OUTPUT
 * and are deliberately not imported — the app computes those from the taps and
 * trips (pay.ts/workedMinutes), so the two can be compared rather than copied.
 *
 * Pure, no server imports: the browser parses the file (so the server never
 * spends CPU on a spreadsheet) and the server re-validates every row it is sent.
 */

export interface ShiftImportRow {
  /** Cartrack account label, e.g. "P - P - PT101235 Bùi Ngọc Thành". The join key. */
  account: string;
  /** "PT101235", or "" where payroll has none yet ("Chưa có code"). */
  code: string;
  date: string;   // YYYY-MM-DD
  start: string;  // HH:MM
  end: string;    // HH:MM
}

const HEADERS = {
  code: "Mã nhân viên",
  account: "Tài khoản nhân viên",
  date: "Ngày làm việc",
  start: "Ca vào",
  end: "Ca ra",
} as const;

const pad = (n: number) => String(n).padStart(2, "0");
const norm = (v: unknown) => String(v ?? "").normalize("NFC").trim();

/** Excel stores a date as days since 1899-12-30 and a time as a fraction of a day. */
function toDate(v: unknown): string | null {
  if (typeof v === "number" && v > 30000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86_400_000).toISOString().slice(0, 10);
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  const s = norm(v);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);               // dd/mm/yyyy, VN order
  return m ? `${m[3]}-${pad(+m[2])}-${pad(+m[1])}` : null;
}

function toTime(v: unknown): string | null {
  if (typeof v === "number" && v >= 0 && v < 1) {
    const mins = Math.round(v * 1440);
    return mins < 1440 ? `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}` : null;
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) return `${pad(v.getHours())}:${pad(v.getMinutes())}`;
  const m = /^(\d{1,2}):(\d{2})/.exec(norm(v));
  return m && +m[1] < 24 && +m[2] < 60 ? `${pad(+m[1])}:${m[2]}` : null;
}

/** Validates one row: a real date, two real times, start before end. */
export function validShiftRow(r: Partial<ShiftImportRow>): r is ShiftImportRow {
  return typeof r.account === "string" && r.account.trim().length > 0 && r.account.length <= 120
    && typeof r.code === "string" && r.code.length <= 20
    && typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date)
    && typeof r.start === "string" && /^\d{2}:\d{2}$/.test(r.start)
    && typeof r.end === "string" && /^\d{2}:\d{2}$/.test(r.end)
    && r.start < r.end;
}

/**
 * The sheet as a grid (xlsx `sheet_to_json(ws, { header: 1, raw: true })`) →
 * shift rows. Columns are found by HEADER NAME, not position, so an inserted
 * column does not silently shift every value into the wrong field.
 */
export function parsePayrollSheet(grid: unknown[][]): { rows: ShiftImportRow[]; skipped: number; error?: string } {
  const headerAt = grid.findIndex((r) => Array.isArray(r) && r.some((c) => norm(c) === HEADERS.account));
  if (headerAt < 0) return { rows: [], skipped: 0, error: `Không thấy cột "${HEADERS.account}" — có đúng file chấm công bán thời gian không?` };
  const header = grid[headerAt].map(norm);
  const col = Object.fromEntries(Object.entries(HEADERS).map(([k, name]) => [k, header.indexOf(name)])) as Record<keyof typeof HEADERS, number>;
  const missing = Object.entries(col).filter(([, i]) => i < 0).map(([k]) => HEADERS[k as keyof typeof HEADERS]);
  if (missing.length) return { rows: [], skipped: 0, error: `Thiếu cột: ${missing.join(", ")}` };

  const rows: ShiftImportRow[] = [];
  let skipped = 0;
  for (const r of grid.slice(headerAt + 1)) {
    if (!Array.isArray(r) || r.every((c) => norm(c) === "")) continue;
    const code = norm(r[col.code]);
    const row = {
      account: norm(r[col.account]),
      code: /^PT\d+$/i.test(code) ? code.toUpperCase() : "",
      date: toDate(r[col.date]) ?? "",
      start: toTime(r[col.start]) ?? "",
      end: toTime(r[col.end]) ?? "",
    };
    if (validShiftRow(row)) rows.push(row); else skipped++;
  }
  return { rows, skipped };
}

/**
 * Which app driver a row belongs to. Exact account label first — it IS the
 * Cartrack label. Then the staff code inside a known label, which survives a
 * rename of the personal name. Nothing fuzzier: two accounts can share a
 * personal name (a PT and a DC twin), and a wrong match pays the wrong person.
 */
export function resolveDriver(row: ShiftImportRow, known: { driver_id: string; driver_name: string | null }[]): string | null {
  const exact = known.find((k) => norm(k.driver_name) === row.account);
  if (exact) return exact.driver_id;
  if (!row.code) return null;
  const byCode = known.filter((k) => new RegExp(`\\b${row.code}\\b`, "i").test(k.driver_name ?? ""));
  return new Set(byCode.map((k) => k.driver_id)).size === 1 ? byCode[0].driver_id : null;
}
