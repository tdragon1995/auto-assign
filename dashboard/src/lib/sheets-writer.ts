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

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${quotedName}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}
