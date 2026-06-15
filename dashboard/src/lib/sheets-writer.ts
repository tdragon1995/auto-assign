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

  // Column B (driver_id) is a per-row xlookup formula in the sheet. A plain
  // append writes a literal UUID into B, wiping the formula on the submitted
  // row. Restore the formula (matching the sheet's existing style) on each
  // appended row so every row stays formula-driven from the name in column C.
  // If the row range can't be parsed we leave the literal — a safe fallback
  // (the row still resolves), never a blank id.
  const updatedRange = appendRes.data.updates?.updatedRange ?? "";
  const startRow = Number(updatedRange.match(/![A-Z]+(\d+)/)?.[1]);
  if (Number.isFinite(startRow)) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: rows.map((_, i) => {
          const r = startRow + i;
          return {
            range: `${quotedName}!B${r}`,
            values: [[`=iferror(xlookup($C${r},Driver!$A:$A,Driver!$B:$B),"")`]],
          };
        }),
      },
    });
  }
}
