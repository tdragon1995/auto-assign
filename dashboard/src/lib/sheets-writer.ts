import { google } from "googleapis";
import { SHEET_ID, SHEET_GID } from "./sheets";
import { timeToMins } from "./time";

let cachedNghiPhepSheetName: string | null = null;

function getSheetsClient(): ReturnType<typeof google.sheets> {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not set");

  // Accepts raw JSON (Vercel UI) or base64-encoded JSON (local .env.local)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let credentials: any;
  try {
    credentials = JSON.parse(keyJson);
  } catch {
    credentials = JSON.parse(Buffer.from(keyJson, "base64").toString("utf8"));
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function getNghiPhepSheetName(
  sheets: ReturnType<typeof google.sheets>
): Promise<string> {
  if (cachedNghiPhepSheetName) return cachedNghiPhepSheetName;
  const res = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = res.data.sheets?.find(
    (s) => String(s.properties?.sheetId) === SHEET_GID.nghi_phep
  );
  if (!sheet?.properties?.title) {
    throw new Error(`Sheet GID ${SHEET_GID.nghi_phep} not found in spreadsheet`);
  }
  cachedNghiPhepSheetName = sheet.properties.title;
  return cachedNghiPhepSheetName;
}

export async function appendNghiPhep(rows: (string | null)[][]): Promise<void> {
  const sheets = getSheetsClient();
  const sheetName = await getNghiPhepSheetName(sheets);
  // Sheet names with spaces must be wrapped in single quotes in A1 notation
  const quotedName = `'${sheetName.replace(/'/g, "''")}'`;

  const appendRes = await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${quotedName}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });

  // The sheet has several per-row FORMULA columns (driver_id, day, sub#_id,
  // scheduled_trips, …). A plain append writes a literal into the ones the form
  // fills (driver_id) and leaves the rest blank on the new row — wiping the
  // formula layout. Re-fill every formula column on the appended row(s) by
  // copy-paste-FORMULA from a template row: this adjusts the relative row refs
  // automatically and is robust to which columns are formulas / how they're laid
  // out. Value columns (the ones the form actually fills) aren't formulas in the
  // template, so they're left exactly as written.
  //
  // This step is BEST-EFFORT. The append above already wrote a functional row:
  // it carries the real driver_id UUID as a literal plus the leave dates, which
  // is all the assign engine needs (loadLeaveEntries reads driver_id directly and
  // drops only rows where it's blank). The formula columns are a supervisor-facing
  // convenience. So if this fails — e.g. a protected-range change revokes the
  // service account's edit access — DON'T throw: a 500 here would make the driver
  // resubmit and duplicate a leave that was already recorded.
  try {
    const updatedRange = appendRes.data.updates?.updatedRange ?? "";
    const startRow = Number(updatedRange.match(/![A-Z]+(\d+)/)?.[1]);
    if (Number.isFinite(startRow)) {
      const sheetId = Number(SHEET_GID.nghi_phep);
      // Scan the first data rows for the formula layout (which column → a row that
      // holds its formula). Avoids depending on any single template row being intact.
      const tpl = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${quotedName}!2:31`,
        valueRenderOption: "FORMULA",
      });
      const tplRows = tpl.data.values ?? [];
      const srcRowForCol = new Map<number, number>(); // colIndex → 1-based sheet row
      const width = tplRows.reduce((w, r) => Math.max(w, r.length), 0);
      for (let c = 0; c < width; c++) {
        for (let i = 0; i < tplRows.length; i++) {
          const v = tplRows[i]?.[c];
          if (typeof v === "string" && v.startsWith("=")) { srcRowForCol.set(c, i + 2); break; }
        }
      }
      if (srcRowForCol.size > 0) {
        const requests = [...srcRowForCol.entries()].map(([col, srcRow]) => ({
          copyPaste: {
            source:      { sheetId, startRowIndex: srcRow - 1,   endRowIndex: srcRow,                     startColumnIndex: col, endColumnIndex: col + 1 },
            destination: { sheetId, startRowIndex: startRow - 1, endRowIndex: startRow - 1 + rows.length, startColumnIndex: col, endColumnIndex: col + 1 },
            pasteType: "PASTE_FORMULA",
          },
        }));
        await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
      }
    }
  } catch (e) {
    // Leave row WAS written and is honoured by the engine; only the formula
    // columns are missing on it and need manual attention in the sheet.
    console.error(
      "[nghi-phep] formula-refill failed — leave row was saved, but its formula " +
      "columns (driver_id formula, day, sub#_id, scheduled_trips, …) were not " +
      "filled. Check that the service account still has edit access to the Leave " +
      "Status sheet's protected ranges.",
      e
    );
  }
}

// ── Fill substitutes on an existing leave row ────────────────────────────────

/** A rejected sub-fill the *user* can fix (row full, row not found, bad
 *  input) — the route maps this to 400 with the message shown verbatim, vs a
 *  real 500 for an unexpected fault. */
export class LeaveWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaveWriteError";
  }
}

export interface LeaveSubWrite {
  /** Sheet display name — MUST match Driver!A:A exactly, or the row's
   *  sub#_id xlookup resolves blank and the engine drops the sub. */
  name: string;
  from: string | null; // "HH:MM" | null = inherit the leave's own window
  to: string | null;
}

export interface LeaveRowMatch {
  driver_id: string;
  leave_from: string; // YYYY-MM-DD as served by /api/leave-status
  /** "HH:MM–HH:MM" for a windowed row, null for full-day — same derivation as
   *  the panel's timeLabel, used to pick between same-day rows. */
  timeLabel: string | null;
}

/** "2026-07-13" and "13/07/2026" both → "2026-07-13"; anything else verbatim. */
function normDate(s: string): string {
  const t = (s ?? "").trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return t;
}

/** Window identity: minutes-pair for a valid window, "full" otherwise —
 *  format-insensitive ("6:30" vs "06:30"). */
function windowKey(from: string | null, to: string | null): string {
  const s = timeToMins(from || null);
  const e = timeToMins(to || null);
  return s >= 0 && e > s ? `${s}-${e}` : "full";
}

/** 0-based column index → A1 letters (0→A, 26→AA). */
function colA1(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Write substitutes into the first free sub slots (sub1..sub3) of the leave
 * row identified by `match`. Only the *_name/*_from/*_to value cells are
 * written — sub#_id stays an xlookup formula (repaired from a template row if
 * the target row lost it). The row is located fresh at write time (driver +
 * leave_from + window), so a stale dashboard row number can't hit the wrong
 * line after the sheet was edited.
 *
 * Returns the 1-based sheet row plus a warning when a written sub's id did not
 * resolve — the engine would silently ignore that sub, so the caller should
 * surface it.
 */
export async function updateLeaveSubs(
  match: LeaveRowMatch,
  subs: LeaveSubWrite[],
): Promise<{ row: number; warning?: string }> {
  if (subs.length < 1 || subs.length > 3) throw new LeaveWriteError("1–3 người thay mỗi lần");
  const sheets = getSheetsClient();
  const sheetName = await getNghiPhepSheetName(sheets);
  const quotedName = `'${sheetName.replace(/'/g, "''")}'`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: quotedName,
  });
  const all = res.data.values ?? [];
  if (all.length < 2) throw new LeaveWriteError("Leave sheet trống");

  // Header-keyed columns, first occurrence wins (mirrors loadLeaveEntries).
  const col: Record<string, number> = {};
  all[0].forEach((h, i) => {
    const k = String(h ?? "").trim();
    if (k && !(k in col)) col[k] = i;
  });
  for (const need of ["driver_id", "leave_from", "leave_from_hr", "leave_to_hr"]) {
    if (!(need in col)) throw new LeaveWriteError(`Thiếu cột "${need}" trong Leave sheet`);
  }
  // A sub slot is usable only if its 3 value columns exist on the sheet.
  const slots = [1, 2, 3].filter(
    (n) => `sub${n}_name` in col && `sub${n}_from` in col && `sub${n}_to` in col,
  );

  const cell = (row: unknown[], name: string): string =>
    String(row[col[name]] ?? "").trim();
  const targetDate = normDate(match.leave_from);
  const [mFrom, mTo] = (match.timeLabel ?? "").split("–");
  const targetWindow = match.timeLabel ? windowKey(mFrom, mTo) : "full";

  let rowNo = 0;
  let freeSlots: number[] = [];
  let foundButFull = false;
  for (let r = 1; r < all.length; r++) {
    const row = all[r];
    if (cell(row, "driver_id") !== match.driver_id) continue;
    if (normDate(cell(row, "leave_from")) !== targetDate) continue;
    if (windowKey(cell(row, "leave_from_hr"), cell(row, "leave_to_hr")) !== targetWindow) continue;
    const free = slots.filter((n) => !cell(row, `sub${n}_name`));
    if (free.length < subs.length) {
      foundButFull = true;
      continue;
    }
    rowNo = r + 1; // 1-based sheet row
    freeSlots = free;
    break;
  }
  if (!rowNo) {
    throw new LeaveWriteError(
      foundButFull
        ? "Dòng nghỉ phép không còn đủ ô người thay trống"
        : "Không tìm thấy dòng nghỉ phép — sheet có thể vừa thay đổi, thử Refresh",
    );
  }

  const used = freeSlots.slice(0, subs.length);
  const data = subs.flatMap((s, i) => {
    const n = used[i];
    return [
      { range: `${quotedName}!${colA1(col[`sub${n}_name`])}${rowNo}`, values: [[s.name]] },
      { range: `${quotedName}!${colA1(col[`sub${n}_from`])}${rowNo}`, values: [[s.from ?? ""]] },
      { range: `${quotedName}!${colA1(col[`sub${n}_to`])}${rowNo}`, values: [[s.to ?? ""]] },
    ];
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: "RAW", data },
  });

  // Best-effort: make sure each used slot's sub#_id xlookup formula exists
  // (damaged rows lose it), then verify it resolved. A written name whose id
  // stays blank is invisible to the engine — worth a loud warning.
  let warning: string | undefined;
  try {
    const idCols = used
      .map((n) => col[`sub${n}_id`])
      .filter((c): c is number => c != null);
    if (idCols.length) {
      const fRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${quotedName}!${rowNo}:${rowNo}`,
        valueRenderOption: "FORMULA",
      });
      const fRow = fRes.data.values?.[0] ?? [];
      const missing = idCols.filter(
        (c) => !(typeof fRow[c] === "string" && String(fRow[c]).startsWith("=")),
      );
      if (missing.length) {
        // Find a template row holding the formula for each missing column.
        const tpl = await sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: `${quotedName}!2:31`,
          valueRenderOption: "FORMULA",
        });
        const tplRows = tpl.data.values ?? [];
        const sheetId = Number(SHEET_GID.nghi_phep);
        const requests = [];
        for (const c of missing) {
          for (let i = 0; i < tplRows.length; i++) {
            const v = tplRows[i]?.[c];
            if (typeof v === "string" && v.startsWith("=")) {
              requests.push({
                copyPaste: {
                  source:      { sheetId, startRowIndex: i + 1,     endRowIndex: i + 2,  startColumnIndex: c, endColumnIndex: c + 1 },
                  destination: { sheetId, startRowIndex: rowNo - 1, endRowIndex: rowNo,  startColumnIndex: c, endColumnIndex: c + 1 },
                  pasteType: "PASTE_FORMULA",
                },
              });
              break;
            }
          }
        }
        if (requests.length) {
          await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
        }
      }
      // Re-read as values: blank id ⇒ xlookup didn't resolve (or formula still missing).
      const vRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${quotedName}!${rowNo}:${rowNo}`,
      });
      const vRow = vRes.data.values?.[0] ?? [];
      const unresolved = used.filter((n) => {
        const c = col[`sub${n}_id`];
        return c != null && !String(vRow[c] ?? "").trim();
      });
      if (unresolved.length) {
        warning =
          "Đã ghi người thay nhưng driver_id chưa resolve trên sheet — kiểm tra tên trong tab Driver";
      }
    }
  } catch (e) {
    console.error("[leave-subs] sub_id formula check failed (subs were written)", e);
    warning = "Đã ghi người thay nhưng chưa kiểm tra được công thức sub_id trên sheet";
  }

  return { row: rowNo, warning };
}
