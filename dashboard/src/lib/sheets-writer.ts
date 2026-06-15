import { google } from "googleapis";
import { SHEET_ID, SHEET_GID } from "./sheets";

let cachedNghiPhepSheetName: string | null = null;

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

  const sheets = google.sheets({ version: "v4", auth });
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
}
