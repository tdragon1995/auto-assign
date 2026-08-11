/**
 * Driver Shift — Sheet Writer Web App
 * ====================================
 * Replaces the old MISA fetch module in this Apps Script project. MISA
 * fetching now happens in CI (misa-fetcher/ in the auto-assign repo) with a
 * fully automatic browser login — no more expired cookies, no more paste
 * dialogs. This file only RECEIVES the finished rows and writes the
 * "Driver Shift" tab, which Apps Script can always do (it owns the sheet).
 *
 * SETUP (once):
 *   1. Paste this file into the cartrack_combined Apps Script project.
 *      (You can delete the old MISA module — updateDriverShiftTable etc.)
 *   2. Replace SHARED_TOKEN below with the token from the misa-fetcher .env /
 *      GitHub secret SHEET_WEBAPP_TOKEN.
 *   3. Deploy → New deployment → type "Web app"
 *        Execute as:      Me
 *        Who has access:  Anyone
 *   4. Copy the /exec URL → set it as SHEET_WEBAPP_URL (GitHub secret + local .env).
 *   5. Optional check: run testWriteSample() from the editor — it writes 2
 *      dummy rows to the sheet so you can confirm permissions before deploying.
 *
 * Payload: POST JSON { token: "...", rows: [[employee_code, full_name, date,
 *          start_time, end_time, leave_start_time, leave_end_time], ...] }
 * The whole tab is cleared and rewritten each call (same as the old module).
 */

// The shared token lives in Script Properties, NOT in this file — so the real
// value is never in version control and re-pasting this file cannot wipe it.
//
// Set it once: Project Settings (⚙) → Script Properties → Add script property
//   Property: SHARED_TOKEN
//   Value:    the same value as SHEET_WEBAPP_TOKEN (misa-fetcher/.env, GitHub secret)
//
// The constant below is only a fallback for a project where the property has
// not been set; leaving it as the placeholder means every write is rejected
// with "invalid token", which is the intended failure.
const SHARED_TOKEN = 'PASTE_TOKEN_HERE';

function getSharedToken_() {
  var fromProps = PropertiesService.getScriptProperties().getProperty('SHARED_TOKEN');
  return fromProps || SHARED_TOKEN;
}
const SHIFT_SHEET_NAME = 'Driver Shift';   // flat: one row per person per day
const GRID_SHEET_NAME  = 'Lịch Ca';        // consolidated: one row per person, one column per day

// Target spreadsheet, addressed by ID so the script writes to the right file
// whether it is bound to that sheet or deployed standalone. This is the same
// spreadsheet the dashboard reads (SHEET_ID in dashboard/src/lib/sheets.ts).
// Set to '' to fall back to the bound/active spreadsheet instead.
const TARGET_SPREADSHEET_ID = '1Bqsm5atLYUQ4gMsL7zHrbrS6YUu7pEDa-Iy_j_wpCss';

function getTargetSpreadsheet_() {
  return TARGET_SPREADSHEET_ID
    ? SpreadsheetApp.openById(TARGET_SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}

function doPost(e) {
  const out = (obj) =>
    ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);

  try {
    const body = JSON.parse(e.postData.contents || '{}');

    if (!body.token || body.token !== getSharedToken_()) {
      return out({ ok: false, error: 'invalid token' });
    }

    // action defaults to 'shifts' so an older caller keeps working unchanged.
    const action = body.action || 'shifts';

    // Serialize concurrent writes (e.g. a retry racing the original request)
    const lock = LockService.getScriptLock();
    lock.waitLock(30 * 1000);
    try {
      if (action === 'shifts') {
        const rows = body.rows;
        if (!Array.isArray(rows) || rows.length === 0) {
          return out({ ok: false, error: 'rows must be a non-empty array' });
        }
        if (rows.some((r) => !Array.isArray(r) || r.length !== 8)) {
          return out({ ok: false, error: 'each row must have exactly 8 columns' });
        }
        writeShiftSheet_(rows);
        return out({ ok: true, written: rows.length, sheet: SHIFT_SHEET_NAME });
      }

      if (action === 'grid') {
        const values = body.values;
        if (!Array.isArray(values) || values.length < 2) {
          return out({ ok: false, error: 'values must be a matrix with a header row' });
        }
        writeGridSheet_(values, body.backgrounds || null, body.month || '', body.frozenRows, body.frozenCols);
        return out({ ok: true, rows: values.length, cols: values[0].length, sheet: GRID_SHEET_NAME });
      }

      return out({ ok: false, error: 'unknown action: ' + action });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return out({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/**
 * Same layout/coloring as the old misaWriteSheet_, plus column H (leave_gap):
 * "1" marks a day the person is away on approved leave but still rostered to
 * work with no leave window — MISA deducted nothing because its company calendar
 * called that day non-working. Those rows are tinted red.
 */
function writeShiftSheet_(rows) {
  const ss = getTargetSpreadsheet_();
  let sheet = ss.getSheetByName(SHIFT_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHIFT_SHEET_NAME);

  const NUM_COLS = 8;

  sheet
    .getRange(1, 1, 1, NUM_COLS)
    .setValues([['employee_code', 'full_name', 'date', 'start_time', 'end_time', 'leave_start_time', 'leave_end_time', 'leave_gap']])
    .setFontWeight('bold');

  const last = sheet.getLastRow();
  if (last >= 2) sheet.getRange(2, 1, last - 1, NUM_COLS).clearContent().setBackground(null);

  sheet.getRange(2, 1, rows.length, NUM_COLS).setValues(rows);

  // leave gap = red (highest priority — needs a human), approved leave = light
  // blue, holiday = amber, day off = light grey
  const gapBg = '#f4b8b8';
  const holidayBg = '#fce8b2';
  const offBg = '#f3f3f3';
  const leaveBg = '#cfe2f3';
  const timeRe = /^\d{2}:\d{2}$/;

  const backgrounds = rows.map((row) => {
    const st = row[3];
    const leaveStart = row[5];
    const leaveGap = row[7];
    let bg = null;
    if (leaveGap === '1' || leaveGap === 1) bg = gapBg;
    else if (leaveStart && leaveStart !== '') bg = leaveBg;
    else if (st === 'OFF') bg = offBg;
    else if (st && !timeRe.test(st)) bg = holidayBg;
    return new Array(NUM_COLS).fill(bg);
  });
  sheet.getRange(2, 1, rows.length, NUM_COLS).setBackgrounds(backgrounds);

  sheet.autoResizeColumns(1, NUM_COLS);
  Logger.log('[shift-webapp] wrote ' + rows.length + ' rows to "' + SHIFT_SHEET_NAME + '"');
}

/**
 * Consolidated month grid: one row per person, one column per day.
 * The caller supplies both the values and a parallel background matrix, so every
 * colour decision lives in one place (misa-fetcher/lib/grid.mjs) rather than
 * being duplicated here.
 */
function writeGridSheet_(values, backgrounds, monthLabel, frozenRows, frozenCols) {
  const ss = getTargetSpreadsheet_();
  let sheet = ss.getSheetByName(GRID_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(GRID_SHEET_NAME);

  const rows = values.length;
  const cols = values[0].length;

  // Full clear: last month's grid may be wider (31 days vs 30) or taller.
  sheet.clear();

  sheet.getRange(1, 1, rows, cols).setValues(values);
  if (backgrounds && backgrounds.length === rows) {
    sheet.getRange(1, 1, rows, cols).setBackgrounds(backgrounds);
  }

  // The caller decides how many header rows there are (currently two: date,
  // then weekday). Freezing and formatting both follow that count so the two
  // stay in step.
  const headerRows = frozenRows || 1;
  sheet.getRange(1, 1, headerRows, cols)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setWrap(false);
  for (var hr = 1; hr <= headerRows; hr++) sheet.setRowHeight(hr, 20);
  // Identity headers read better left-aligned than centred over a name column.
  sheet.getRange(1, 1, headerRows, 3).setHorizontalAlignment('left');

  // Day cells: small and centred so a whole month fits on screen. The three
  // identity columns stay left-aligned and readable.
  if (cols > 3) {
    // 56px fits the widest cell ("12:30-21:30") at 8pt without clipping; wrap is
    // off so a long value never doubles a row's height.
    sheet.getRange(1, 4, rows, cols - 3).setHorizontalAlignment('center').setFontSize(8);
    sheet.getRange(headerRows + 1, 4, rows - headerRows, cols - 3).setWrap(false);
    for (let c = 4; c <= cols; c++) sheet.setColumnWidth(c, 56);
  }
  sheet.getRange(1, 1, rows, 1).setFontSize(9);
  sheet.setColumnWidth(1, 190); // name
  sheet.setColumnWidth(2, 80);  // employee code
  sheet.setColumnWidth(3, 55);  // source

  sheet.setFrozenRows(frozenRows || 1);
  sheet.setFrozenColumns(frozenCols || 3);

  // Legend below the grid — the colours carry the meaning, so name them.
  const legendRow = rows + 2;
  sheet.getRange(legendRow, 1).setValue(
    'Lịch ca tháng ' + (monthLabel || '') + ' — cập nhật ' +
    Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd HH:mm'),
  ).setFontWeight('bold');

  const legend = [
    ['6-15', 'Ca làm việc (giờ bắt đầu - kết thúc)', null],
    ['', 'Ngày nghỉ tuần', '#f3f3f3'],
    ['P', 'Nghỉ phép', '#cfe2f3'],
    ['⚠', 'Nghỉ phép nhưng vẫn có ca — cần kiểm tra', '#f4b8b8'],
    ['Lễ', 'Ngày lễ', '#fce8b2'],
  ];
  for (let i = 0; i < legend.length; i++) {
    const r = legendRow + 1 + i;
    sheet.getRange(r, 1).setValue(legend[i][0]).setHorizontalAlignment('center');
    // Not merged: a merge spanning the frozen/non-frozen column boundary is
    // rejected by Sheets. Plain text overflows into the empty cells anyway.
    sheet.getRange(r, 2).setValue(legend[i][1]);
    if (legend[i][2]) sheet.getRange(r, 1).setBackground(legend[i][2]);
  }

  Logger.log('[shift-webapp] grid ' + rows + 'x' + cols + ' → "' + GRID_SHEET_NAME + '"');
}

/**
 * Diagnostic — run this from the editor (Run ▶ with checkToken selected) and
 * read the Execution log. Editor runs use the CURRENT code, not the deployed
 * version, so this tells you whether the script property is readable
 * independently of whether the deployment is up to date.
 *
 *   "property: NOT SET"  → add SHARED_TOKEN in Project Settings → Script Properties
 *   "property: set …"    → the property is fine; the DEPLOYMENT is stale,
 *                          so redeploy with Version = New version
 */
function checkToken() {
  var p = PropertiesService.getScriptProperties().getProperty('SHARED_TOKEN');
  var eff = getSharedToken_();
  Logger.log('property: ' + (p ? 'set, length ' + p.length + ', starts "' + p.substring(0, 6) + '"' : 'NOT SET'));
  Logger.log('effective token starts: "' + eff.substring(0, 6) + '"');
  Logger.log(eff === 'PASTE_TOKEN_HERE'
    ? '=> still the placeholder — writes will be rejected'
    : '=> a real token is in use');
}

/** Editor smoke test — writes 3 dummy rows so you can verify before deploying. */
function testWriteSample() {
  writeShiftSheet_([
    ['TEST01', 'Nguyễn Văn Test', '2026-08-18', '06:00', '15:00', '', '', ''],
    ['TEST01', 'Nguyễn Văn Test', '2026-08-19', 'OFF', '', '10:00', '23:59', ''],
    ['TEST01', 'Nguyễn Văn Test', '2026-08-20', '06:00', '15:00', '', '', '1'],
  ]);
  Logger.log('✅ 3 test rows written to "' + SHIFT_SHEET_NAME + '" in ' + getTargetSpreadsheet_().getName());
}
