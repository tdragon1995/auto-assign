import { google } from "googleapis";
import { SHEET_ID, SHEET_GID } from "./sheets";
import { vnIsSunday, vnTimestamp } from "./time";
import { LEAVE_DELETED_SHEET, LEAVE_DELETED_HEADERS } from "./leave-suppression";
import type { ConfigCells } from "./unmapped-row";
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

// ── Delete one leave row ─────────────────────────────────────────────────────
//
// WHY THIS EXISTS. A MISA leave request is often only PARTLY approved — three
// days asked for, one granted — but the sync has already written a row per
// charged day, and a supervisor rejecting the rest in MISA changes nothing here.
// Until now the only fix was opening the workbook by hand, which is exactly the
// step that goes undone; meanwhile the engine keeps the driver off and their
// lane keeps failing as "Nghỉ, không người thay".
//
// It also gives the panel's existing "Trùng dòng — dọn sheet" flag something to
// press: that warning has been asking for a manual cleanup since it was added.

/** One sheet row that matched a delete request, with what makes it a better or
 *  worse candidate to remove. Exported for the offline test. */
export interface LeaveRowCandidate {
  /** 1-based sheet row. */
  row: number;
  /** How many substitute slots are filled — a covered row is the one to KEEP. */
  subCount: number;
  driver_name: string;
  loai_nghi: string;
  leave_from: string;
  leave_to: string | null;
  /** The row's own hour window, verbatim from the sheet. Recorded rather than
   *  re-derived from the panel's label so a suppression matches the row that
   *  actually went, down to a "6:00" the panel rendered as "06:00". */
  leave_from_hr: string | null;
  leave_to_hr: string | null;
  note: string;
}

/** The sub slots the loader reads (`buildSub` walks 1–4), not the three the
 *  sub-editor writes: a row can carry a fourth filled in by hand. */
const SUB_SLOTS = [1, 2, 3, 4];

/**
 * Every row that IS the leave the dashboard is pointing at: same driver, same
 * start date, same window. Identity is re-derived from the sheet at write time
 * (never a row number carried by the client), so an edit that shifted rows
 * cannot make this hit the wrong line.
 *
 * Pure — takes the parsed grid — so the choice below can be pinned by a test.
 */
export function matchLeaveRows(
  all: unknown[][],
  col: Record<string, number>,
  match: LeaveRowMatch,
): LeaveRowCandidate[] {
  const cell = (row: unknown[], name: string): string =>
    col[name] == null ? "" : String(row[col[name]] ?? "").trim();
  const targetDate = normDate(match.leave_from);
  const [mFrom, mTo] = (match.timeLabel ?? "").split("–");
  const targetWindow = match.timeLabel ? windowKey(mFrom, mTo) : "full";

  const out: LeaveRowCandidate[] = [];
  for (let r = 1; r < all.length; r++) {
    const row = all[r];
    if (!row) continue;
    if (cell(row, "driver_id") !== match.driver_id) continue;
    if (normDate(cell(row, "leave_from")) !== targetDate) continue;
    if (windowKey(cell(row, "leave_from_hr"), cell(row, "leave_to_hr")) !== targetWindow) continue;
    out.push({
      row: r + 1, // 1-based sheet row
      subCount: SUB_SLOTS.filter((n) => cell(row, `sub${n}_name`) || cell(row, `sub${n}_id`)).length,
      driver_name: cell(row, "driver"),
      loai_nghi: cell(row, "Loại Nghỉ"),
      leave_from: normDate(cell(row, "leave_from")),
      leave_to: normDate(cell(row, "leave_to")) || null,
      leave_from_hr: cell(row, "leave_from_hr") || null,
      leave_to_hr: cell(row, "leave_to_hr") || null,
      note: cell(row, "note"),
    });
  }
  return out;
}

/**
 * Which of several identical rows to remove.
 *
 * Fewest substitutes first: when the sheet holds the duplicate pair this panel
 * already flags — one row the requester typed and one the supervisor filled
 * cover into — the empty one is the redundant copy and the covered one is the
 * record. Ties go to the LAST row, i.e. the most recently appended, which is the
 * one a re-push added.
 *
 * One row per call, deliberately: deleting a whole duplicate set on one click
 * would take the covered row with it.
 */
export function pickLeaveRowToDelete(candidates: LeaveRowCandidate[]): LeaveRowCandidate | null {
  let best: LeaveRowCandidate | null = null;
  for (const c of candidates) {
    if (!best || c.subCount < best.subCount || (c.subCount === best.subCount && c.row > best.row)) {
      best = c;
    }
  }
  return best;
}

export interface LeaveRowDeletion {
  /** The 1-based sheet row that was removed. */
  row: number;
  driver_name: string;
  loai_nghi: string;
  leave_from: string;
  leave_to: string | null;
  leave_from_hr: string | null;
  leave_to_hr: string | null;
  note: string;
  /** Identical rows still on the sheet after this one went — a duplicate set
   *  needs one click per copy, and the caller says so rather than leaving the
   *  supervisor to notice the flag did not clear. */
  remaining: number;
}

/**
 * Remove ONE leave row from the Nghỉ phép tab.
 *
 * Deletes the whole sheet row rather than blanking its cells: a blanked row
 * keeps its formula columns alive and re-reads as an empty-but-present entry,
 * and the loader's orphan reporting would then have to tell "cleared on purpose"
 * from "lookup broke", which it cannot.
 *
 * Two things it refuses rather than guesses at:
 *   - a row it cannot find (the sheet moved under a stale dashboard) — the
 *     supervisor refreshes and looks again;
 *   - the FIRST data row. The tab is an append log, so row 2 is months old and
 *     never today's leave, but it is where a column-wide formula would be
 *     anchored — and this workbook has already lost a whole column of ids to
 *     exactly that mistake (see the header of the config writers below).
 */
export async function deleteLeaveRow(match: LeaveRowMatch): Promise<LeaveRowDeletion> {
  const sheets = getSheetsClient();
  const sheetName = await getNghiPhepSheetName(sheets);
  const quotedName = `'${sheetName.replace(/'/g, "''")}'`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: quotedName,
  });
  const all = res.data.values ?? [];
  if (all.length < 2) throw new LeaveWriteError("Leave sheet trống");

  const col: Record<string, number> = {};
  all[0].forEach((h, i) => {
    const k = String(h ?? "").trim();
    if (k && !(k in col)) col[k] = i;
  });
  for (const need of ["driver_id", "leave_from", "leave_from_hr", "leave_to_hr"]) {
    if (!(need in col)) throw new LeaveWriteError(`Thiếu cột "${need}" trong Leave sheet`);
  }

  const candidates = matchLeaveRows(all, col, match);
  const victim = pickLeaveRowToDelete(candidates);
  if (!victim) {
    throw new LeaveWriteError(
      "Không tìm thấy dòng nghỉ phép — sheet có thể vừa thay đổi, thử Refresh",
    );
  }
  if (victim.row <= 2) {
    throw new LeaveWriteError(
      "Dòng đầu bảng giữ công thức của cả cột — xoá trực tiếp trên sheet nếu thật sự cần",
    );
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: Number(SHEET_GID.nghi_phep),
              dimension: "ROWS",
              startIndex: victim.row - 1, // 0-based, inclusive
              endIndex: victim.row,       // exclusive
            },
          },
        },
      ],
    },
  });

  return {
    row: victim.row,
    driver_name: victim.driver_name,
    loai_nghi: victim.loai_nghi,
    leave_from: victim.leave_from,
    leave_to: victim.leave_to,
    leave_from_hr: victim.leave_from_hr,
    leave_to_hr: victim.leave_to_hr,
    note: victim.note,
    remaining: candidates.length - 1,
  };
}

// ── The deletion log, which is also a suppression list ───────────────────────
//
// A delete on its own does not settle anything. The MISA pusher re-derives every
// charged day from today forward on each run and dedupes purely on the row being
// present, so removing a future day MISA still charges is undone at the next
// 04:45 / 12:00 sync — which is exactly the case this whole feature is for.
//
// So a delete also writes a line here, and /api/nghi-phep refuses to re-create a
// day that carries one. Two properties keep this from becoming a second source
// of truth quietly disagreeing with MISA:
//
//   - it only ever blocks an AUTOMATED push. A person filing leave through the
//     app or the panel is never blocked by it, so the escape hatch is always the
//     obvious action rather than sheet surgery;
//   - it is a visible TAB, listed in the dashboard panel, one line per deleted
//     row with who and when. Removing the line — from the panel's "Khôi phục"
//     button or by hand — lets the next sync bring the leave back.
//
// Created on first use, same as the Nhận Việc log below.

let leaveDeletedSheetReady = false;

/** Ensure the tab exists, with its header row. */
async function ensureLeaveDeletedSheet(sheets: ReturnType<typeof google.sheets>): Promise<number> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const found = meta.data.sheets?.find((x) => x.properties?.title === LEAVE_DELETED_SHEET);
  if (found?.properties?.sheetId != null) {
    leaveDeletedSheetReady = true;
    return found.properties.sheetId;
  }
  const created = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: LEAVE_DELETED_SHEET } } }] },
  });
  const sheetId = created.data.replies?.[0]?.addSheet?.properties?.sheetId;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${LEAVE_DELETED_SHEET}'!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [[...LEAVE_DELETED_HEADERS]] },
  });
  leaveDeletedSheetReady = true;
  if (sheetId == null) throw new Error(`could not create "${LEAVE_DELETED_SHEET}"`);
  return sheetId;
}

/** Log one removed leave row. Column order matches LEAVE_DELETED_HEADERS. */
export async function appendLeaveDeletion(
  deleted: LeaveRowDeletion,
  driver_id: string,
): Promise<void> {
  const sheets = getSheetsClient();
  if (!leaveDeletedSheetReady) await ensureLeaveDeletedSheet(sheets);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${LEAVE_DELETED_SHEET}'!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        vnTimestamp(), driver_id, deleted.driver_name, deleted.loai_nghi,
        deleted.leave_from, deleted.leave_to ?? "",
        deleted.leave_from_hr ?? "", deleted.leave_to_hr ?? "", deleted.note,
      ]],
    },
  });
}

/**
 * Drop one suppression line, so the next MISA sync may write that day again.
 *
 * Located the same way a leave row is — driver + start date + window, re-read at
 * write time — because the same reasoning applies: the dashboard's copy of this
 * tab is as old as its last refresh. Removes ONE line; a duplicate log entry for
 * the same day is harmless (they suppress identically) and clearing one at a
 * time keeps this symmetric with the delete it undoes.
 */
export async function removeLeaveSuppression(match: LeaveRowMatch): Promise<{ row: number }> {
  const sheets = getSheetsClient();
  const sheetId = await ensureLeaveDeletedSheet(sheets);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${LEAVE_DELETED_SHEET}'`,
  });
  const all = res.data.values ?? [];
  if (all.length < 2) throw new LeaveWriteError("Chưa có dòng nghỉ nào bị xoá");

  const col: Record<string, number> = {};
  all[0].forEach((h, i) => {
    const k = String(h ?? "").trim();
    if (k && !(k in col)) col[k] = i;
  });
  const cell = (row: unknown[], name: string): string =>
    col[name] == null ? "" : String(row[col[name]] ?? "").trim();

  const targetDate = normDate(match.leave_from);
  const [mFrom, mTo] = (match.timeLabel ?? "").split("–");
  const targetWindow = match.timeLabel ? windowKey(mFrom, mTo) : "full";

  // Last match wins: the newest line is the one the panel is showing.
  let rowNo = 0;
  for (let r = 1; r < all.length; r++) {
    const row = all[r];
    if (!row) continue;
    if (cell(row, "driver_id") !== match.driver_id) continue;
    if (normDate(cell(row, "leave_from")) !== targetDate) continue;
    if (windowKey(cell(row, "leave_from_hr"), cell(row, "leave_to_hr")) !== targetWindow) continue;
    rowNo = r + 1;
  }
  if (!rowNo) {
    throw new LeaveWriteError("Không tìm thấy dòng đã xoá — bấm Làm mới rồi thử lại");
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: rowNo - 1, endIndex: rowNo },
        },
      }],
    },
  });
  return { row: rowNo };
}

// ── Nhận Việc (driver self-claim) audit log ──────────────────────────────────

const NV_LOG_SHEET = "Nhận Việc Log";
const NV_LOG_HEADERS = [
  "Thời gian", "Tài xế", "driver_id", "Job ID", "Mã đơn",
  "Điểm lấy", "Điểm giao", "Tài xế trước đó", "Trạng thái lấy hàng",
];
let nvLogSheetReady = false;

/** Ensure the log tab exists (create with a header row on first use). */
async function ensureNvLogSheet(sheets: ReturnType<typeof google.sheets>): Promise<void> {
  if (nvLogSheetReady) return;
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === NV_LOG_SHEET);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: NV_LOG_SHEET } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${NV_LOG_SHEET}'!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [NV_LOG_HEADERS] },
    });
  }
  nvLogSheetReady = true;
}

/** Append one audit row for a successful driver self-claim. Order matches
 *  NV_LOG_HEADERS. Caller should treat this as best-effort (don't fail the claim
 *  if it throws). */
export async function appendNhanViecLog(row: (string | number | null)[]): Promise<void> {
  const sheets = getSheetsClient();
  await ensureNvLogSheet(sheets);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${NV_LOG_SHEET}'!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

// ── Writing config rows ─────────────────────────────────────────────────────
//
// READ THIS BEFORE CHANGING ANYTHING HERE. Two tabs, two different layouts, and
// each has a way of being written that destroys it.
//
// WEEKDAY ("config"). Its four id columns are a SINGLE ARRAYFORMULA each, living
// in row 2 and spilling down the table. Nothing may ever be written into A–D, not
// even an empty string: a literal anywhere in a spill range collapses it to #REF!
// and, because it is one formula per column, blanks EVERY branch id at once.
// Proven live on 2026-08-26.
//
// SUNDAY ("(NO edit) CONFIG SUNDAY"). Almost the opposite. Its formulas are
// PER-ROW and propagate onto a new row inside the table on their own, so nothing
// needs copying. But its Driver column is itself a FORMULA — the one that derives
// who covers each area from the public Sunday roster — so writing a driver there,
// even a blank, destroys the derivation for that row. And its only destination
// column is an alternate-destination OVERRIDE, which rewrites where a job goes;
// putting the observed destination in it would redirect real trips. So on Sunday
// the destination is not written at all.
//
// NEITHER tab may be written with values.append. `append` cannot be scoped to a
// column span — the range only locates the table, and the write then starts at the
// table's FIRST column. That is exactly how the weekday incident happened. Both
// paths below use explicit, column-scoped values.update ranges.
//
// WHERE THE ROWS GO. Into the empty rows that already exist INSIDE the table
// (weekday ~236, Sunday ~1,195). A row below the table is outside the formulas'
// reach and its ids would stay blank forever, so this refuses rather than writing
// there.

export interface ConfigTabSpec {
  /** Tab name as it appears in the workbook. */
  title: string;
  gid: string;
}

/** Exported so both tabs stay pinned by a test. */
export const CONFIG_TABS: Record<"weekday" | "sunday", ConfigTabSpec> = {
  weekday: { title: "config", gid: SHEET_GID.mapping },
  sunday:  { title: "(NO edit) CONFIG SUNDAY", gid: SHEET_GID.sunday },
};

/** Which tab the engine is reading right now. Matched to `loadConfigFromSheets`
 *  deliberately: a row written into the tab the engine is NOT reading today fixes
 *  nothing, and quietly adds a rule to the other half of the week. */
export function currentConfigTab(): ConfigTabSpec {
  return vnIsSunday() ? CONFIG_TABS.sunday : CONFIG_TABS.weekday;
}

const a1 = (t: ConfigTabSpec) => `'${t.title.replace(/'/g, "''")}'`;

/** 0-based column index → A1 letter. */
function colLetter(i: number): string {
  let s = "", n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

/**
 * The columns this may write, BY NAME.
 *
 * Named rather than lettered because the letters differ per tab and move when
 * anyone reorganises the sheet — the assumption that has already cost this
 * project two incidents. Looking them up means a column that moves is followed,
 * and a column that is renamed makes the write REFUSE rather than land somewhere
 * arbitrary.
 *
 * The safety property is what is ABSENT. Every id column, every formula column
 * and — importantly — "Điểm Drop-off thay thế" are simply never named here, so
 * no code path can reach them. That last one is a value column and would look
 * writable, but it is an OVERRIDE that rewrites where a job goes; putting an
 * observed destination in it would redirect real trips.
 */
export const WRITE_COLS = {
  pickup: "Điểm Pick-up",
  /** Matches a destination. Present on the weekday tab; not yet on Sunday, where
   *  a row simply covers every destination until the column is added. Looked up
   *  rather than assumed, so it starts being written the day it appears. */
  dropoff: "Điểm Drop-off",
  start: "shift_start",
  end: "shift_end",
} as const;

/** Header name → A1 letter, for the columns this writes. Missing optional ones
 *  are simply absent; a missing required one throws. */
async function writableColumns(
  sheets: ReturnType<typeof google.sheets>,
  tab: ConfigTabSpec,
): Promise<{ pickup: string; dropoff: string | null; start: string; end: string }> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${a1(tab)}!1:1`,
  });
  const header = (res.data.values?.[0] ?? []).map((h) => String(h ?? "").trim());
  const at = (name: string) => {
    const i = header.indexOf(name);
    return i < 0 ? null : colLetter(i);
  };
  const pickup = at(WRITE_COLS.pickup), start = at(WRITE_COLS.start), end = at(WRITE_COLS.end);
  const missing = [
    !pickup && WRITE_COLS.pickup, !start && WRITE_COLS.start, !end && WRITE_COLS.end,
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`"${tab.title}" has no ${missing.join(", ")} column — refusing to guess where to write`);
  }
  return { pickup: pickup!, dropoff: at(WRITE_COLS.dropoff), start: start!, end: end! };
}

/** Where the table ends and where its first free row is. Read live rather than
 *  hardcoded, so extending the table by hand is all it takes to make room. */
async function configTableBounds(
  sheets: ReturnType<typeof google.sheets>,
  tab: ConfigTabSpec,
  pickupCol: string,
): Promise<{ firstFreeRow: number; lastTableRow: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta: any = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: "sheets(properties(sheetId),tables(name,range))",
  });
  const sheet = meta.data.sheets?.find(
    (x: { properties?: { sheetId?: number } }) => String(x.properties?.sheetId) === String(tab.gid),
  );
  const table = sheet?.tables?.[0];
  if (!table?.range?.endRowIndex) throw new Error(`no table on "${tab.title}" — refusing to guess where rows belong`);
  const lastTableRow = Number(table.range.endRowIndex);   // exclusive 0-based == last 1-based row

  const col = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${a1(tab)}!${pickupCol}1:${pickupCol}${lastTableRow}`,
  });
  // The pickup column is the entry key every id formula reads, so a row blank
  // THERE is a row nothing depends on — the right definition of "free".
  const vals = (col.data.values ?? []).map((r) => String(r?.[0] ?? "").trim());
  let lastUsed = 1;
  vals.forEach((v, i) => { if (v) lastUsed = i + 1; });
  return { firstFreeRow: lastUsed + 1, lastTableRow };
}

/**
 * Write config lines into the spare rows inside whichever tab the engine is
 * reading today. Returns the 1-based row numbers written.
 */
export async function writeConfigRows(cells: ConfigCells[]): Promise<number[]> {
  if (cells.length === 0) return [];
  const tab = currentConfigTab();
  const sheets = getSheetsClient();
  const cols = await writableColumns(sheets, tab);
  const { firstFreeRow, lastTableRow } = await configTableBounds(sheets, tab, cols.pickup);

  const lastNeeded = firstFreeRow + cells.length - 1;
  if (lastNeeded > lastTableRow) {
    throw new Error(
      `"${tab.title}" is full: rows ${firstFreeRow}–${lastNeeded} needed but the table ends at ${lastTableRow}. ` +
      `Extend the table in the sheet — writing below it would leave every id blank.`,
    );
  }

  // ONE RANGE PER COLUMN, never a span. A span would silently include whatever
  // sits between two columns, and what sits between them differs per tab and
  // moves when the sheet is reorganised — on Sunday it is the Driver formula,
  // which a blank would destroy. Addressing each column on its own makes it
  // impossible to touch a column this did not name.
  const q = a1(tab);
  const range = (c: string) => `${q}!${c}${firstFreeRow}:${c}${lastNeeded}`;
  const data: { range: string; values: string[][] }[] = [
    { range: range(cols.pickup), values: cells.map((c) => [c.pickup]) },
    { range: range(cols.start),  values: cells.map((c) => [c.start]) },
    { range: range(cols.end),    values: cells.map((c) => [c.end]) },
  ];
  // Only when the tab actually has a destination column to match on. Without one
  // the row covers every destination, which is the correct and safe default.
  if (cols.dropoff) {
    data.push({ range: range(cols.dropoff), values: cells.map((c) => [c.dropoff]) });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: "USER_ENTERED", data },
  });

  // No formula-copy step on either tab: a row inside the table inherits its
  // column formulas. Just as well — both tabs carry an active filter, and
  // copyPaste refuses any range covering one.
  return cells.map((_, i) => firstFreeRow + i);
}

/**
 * Fill in the driver (and optionally the hours) on a row this system created.
 *
 * WEEKDAY ONLY, and it refuses rather than assumes. On the Sunday tab the Driver
 * column is a FORMULA deriving who covers each area from the public roster —
 * writing a name over it destroys that derivation for the row, and there is no
 * way to put it back from here.
 *
 * The row number is a HINT. It comes from the parsed index of a sheet read that
 * may be minutes old, and rows shift when anyone inserts or deletes above them —
 * observed moving by three in a single morning. So the branch is re-read and
 * compared before anything is written; a mismatch throws rather than writing a
 * driver onto whatever happens to live there now.
 */
export async function completeConfigRow(opts: {
  row: number;
  expectPickup: string;
  driverName: string;
  start?: string;
  end?: string;
}): Promise<void> {
  const tab = currentConfigTab();
  if (tab.gid !== CONFIG_TABS.weekday.gid) {
    throw new Error(
      "Chủ nhật: tài xế được suy ra từ lịch trực công khai, không chọn trong config — sửa trên tab lịch Chủ nhật",
    );
  }
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${a1(tab)}!1:1`,
  });
  const header = (res.data.values?.[0] ?? []).map((h) => String(h ?? "").trim());
  const at = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`"${tab.title}" không có cột ${name}`);
    return colLetter(i);
  };
  const pickupCol = at(WRITE_COLS.pickup);
  const driverCol = at("Driver");
  const startCol = at(WRITE_COLS.start);
  const endCol = at(WRITE_COLS.end);

  // Confirm the row still holds the branch the dashboard was looking at.
  const check = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${a1(tab)}!${pickupCol}${opts.row}`,
  });
  const found = String(check.data.values?.[0]?.[0] ?? "").trim();
  if (found !== opts.expectPickup.trim()) {
    throw new Error(
      `Dòng ${opts.row} giờ là "${found || "(trống)"}", không phải "${opts.expectPickup}" — ` +
      `sheet đã thay đổi, bấm Refresh rồi thử lại`,
    );
  }

  const q = a1(tab);
  const data: { range: string; values: string[][] }[] = [
    { range: `${q}!${driverCol}${opts.row}`, values: [[opts.driverName]] },
  ];
  if (opts.start && opts.end) {
    data.push({ range: `${q}!${startCol}${opts.row}:${endCol}${opts.row}`, values: [[opts.start, opts.end]] });
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: "USER_ENTERED", data },
  });
}

/**
 * Delete one config row — how a duplicate rule is removed.
 *
 * It removes the SHEET ROW. The first version blanked the row's value cells
 * instead, on the reasoning that a row with no pickup is one the engine drops
 * and one `writeConfigRows` treats as free space. Half of that was wrong:
 * `configTableBounds` puts `firstFreeRow` after the LAST non-blank pickup, so a
 * blank in the MIDDLE of the table is skipped over, never reused. Blanking
 * therefore left a hole in the sheet AND gave back no capacity — the worst of
 * both. Deleting the row closes the hole and returns a row to the table.
 *
 * WHAT MAKES THIS SAFE, given the tab's four id columns are a single
 * ARRAYFORMULA each anchored in row 2: deleting a row inside a spill is not the
 * same as WRITING into one. A literal written into a spill collapses it to
 * #REF! — the incident this file's header records — while a deleted row simply
 * shrinks it. The anchor itself is the exception, so row 2 is refused outright,
 * and the delete is followed by a read-back that would catch a collapse loudly
 * rather than leaving the engine to run on a blanked id column.
 *
 * ROW NUMBERS BELOW THIS ONE ALL SHIFT UP BY ONE, and the dashboard is holding
 * some of them for its other to-dos. That is safe rather than merely tolerable:
 * every writer re-reads its row and compares the branch before writing, so a
 * stale number produces a refusal, never a write to the wrong line. The stale
 * numbers clear on the next parse.
 *
 * WEEKDAY ONLY, like the other writers: the Sunday tab's Driver column is a
 * formula deriving cover from the public roster.
 */
export async function deleteConfigRow(opts: {
  row: number;
  expectPickup: string;
}): Promise<void> {
  const tab = currentConfigTab();
  if (tab.gid !== CONFIG_TABS.weekday.gid) {
    throw new Error(
      "Chủ nhật: dòng được suy ra từ lịch trực công khai — sửa trên tab lịch Chủ nhật",
    );
  }
  if (opts.row <= 2) {
    throw new Error(
      "Dòng 2 giữ công thức id của cả cột — xoá dòng này sẽ hỏng toàn bộ bảng. " +
      "Xoá nội dung dòng bằng tay trên sheet nếu thật sự cần.",
    );
  }
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${a1(tab)}!1:1`,
  });
  const header = (res.data.values?.[0] ?? []).map((h) => String(h ?? "").trim());
  const at = (name: string) => {
    const i = header.indexOf(name);
    return i < 0 ? null : colLetter(i);
  };
  const pickupCol = at(WRITE_COLS.pickup);
  if (!pickupCol) throw new Error(`"${tab.title}" không có cột ${WRITE_COLS.pickup}`);

  // The row number came from a parse that may be minutes old, and rows shift
  // whenever anyone inserts or deletes above them — so confirm the row still
  // holds the branch the dashboard was looking at before removing anything.
  const check = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${a1(tab)}!${pickupCol}${opts.row}`,
  });
  const found = String(check.data.values?.[0]?.[0] ?? "").trim();
  if (found !== opts.expectPickup.trim()) {
    throw new Error(
      `Dòng ${opts.row} giờ là "${found || "(trống)"}", không phải "${opts.expectPickup}" — ` +
      `sheet đã thay đổi, bấm Refresh rồi thử lại`,
    );
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: Number(tab.gid),
            dimension: "ROWS",
            startIndex: opts.row - 1, // 0-based, inclusive
            endIndex: opts.row,       // exclusive
          },
        },
      }],
    },
  });

  // Read back the anchored id column. If the spill had collapsed, EVERY cell in
  // it would read #REF! — so the rows nearest the anchor answer the question,
  // and they answer it in one small read. Best-effort: the row is already gone,
  // and a failed check must not be reported as a failed delete.
  try {
    const idCol = at("customer_id");
    if (idCol) {
      const back = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${a1(tab)}!${idCol}2:${idCol}12`,
      });
      const broken = (back.data.values ?? []).some((r) =>
        String(r?.[0] ?? "").includes("#REF!"),
      );
      if (broken) {
        console.error(
          `[config] DELETING ROW ${opts.row} COLLAPSED THE customer_id ARRAYFORMULA on ` +
          `"${tab.title}" — every branch id is now #REF! and the engine can map nothing. ` +
          `Undo it in the sheet's version history immediately.`,
        );
      }
    }
  } catch (e) {
    console.error("[config] post-delete id-column check failed", e);
  }
}

/**
 * Move one end of an existing rule's window — how an uncovered hour is closed.
 *
 * Deliberately one boundary at a time. The hole between "cover ends 14:30" and
 * "next starts 16:30" is closed either by the earlier rule running later or the
 * later one starting sooner, and which is right depends on who is actually
 * working; the dashboard offers both and a person picks. Writing both would
 * create an overlap, which is the fault this system already reports.
 *
 * Same guards as completing a row: weekday only, and the branch is re-read and
 * compared before anything is written, because the row number came from a parse
 * that may be minutes old.
 */
export async function adjustConfigRowWindow(opts: {
  row: number;
  expectPickup: string;
  edge: "start" | "end";
  value: string;
}): Promise<void> {
  const tab = currentConfigTab();
  if (tab.gid !== CONFIG_TABS.weekday.gid) {
    throw new Error("Chủ nhật: ca được suy ra từ lịch trực công khai — sửa trên tab lịch Chủ nhật");
  }
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${a1(tab)}!1:1` });
  const header = (res.data.values?.[0] ?? []).map((h) => String(h ?? "").trim());
  const at = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`"${tab.title}" không có cột ${name}`);
    return colLetter(i);
  };
  const pickupCol = at(WRITE_COLS.pickup);
  const target = at(opts.edge === "start" ? WRITE_COLS.start : WRITE_COLS.end);

  const check = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${a1(tab)}!${pickupCol}${opts.row}`,
  });
  const found = String(check.data.values?.[0]?.[0] ?? "").trim();
  if (found !== opts.expectPickup.trim()) {
    throw new Error(
      `Dòng ${opts.row} giờ là "${found || "(trống)"}", không phải "${opts.expectPickup}" — ` +
      `sheet đã thay đổi, bấm Refresh rồi thử lại`,
    );
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${a1(tab)}!${target}${opts.row}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[opts.value]] },
  });
}
