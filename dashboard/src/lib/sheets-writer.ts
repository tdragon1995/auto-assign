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
