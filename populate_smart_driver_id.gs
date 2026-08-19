// ── Smart driver_id populator ────────────────────────────────────────────────
// All config + helpers are namespaced under SMARTID_ / smartId* so nothing
// collides with the Cartrack fetcher or MISA scripts sharing this project.
// (Apps Script has ONE global scope across every .gs file.)

const SMARTID_CFG = {
  scheduleSheet: "config",
  masterSheet:   "Driver",
  driverCol:     6,    // F = Driver (multi-select of names)
  // Flip to 11 (K = smart_driver_id) once validation looks right.
  // 12 = L (scratch "Column 12") keeps the real column untouched while validating.
  outputCol:     12,
};

// ── Shared helpers ──────────────────────────────────────────────────────────
function smartIdBuildLookup() {
  const masterSheet = SpreadsheetApp.getActive().getSheetByName(SMARTID_CFG.masterSheet);
  if (!masterSheet) return null;
  const master = masterSheet.getRange("A2:B").getDisplayValues();
  const lookup = {};
  master.forEach(([name, id]) => {
    if (name && id) lookup[String(name).trim()] = String(id).trim();
  });
  return lookup;
}

// Returns { ids: "id,id", missing: ["name", ...] } or null when 0/1 drivers.
function smartIdResolveRow(driverCell, lookup) {
  if (!driverCell) return null;
  const drivers = String(driverCell).split(/,|\n/).map(s => s.trim()).filter(String);

  // By design: smart_driver_id only populates for 2+ candidates.
  // A single driver should use the fixed driver_id column instead.
  if (drivers.length <= 1) return null;

  const missing = drivers.filter(d => !lookup[d]);
  const ids = drivers.map(d => lookup[d] || "").filter(String);
  return { ids: [...new Set(ids)].join(","), missing };
}

function smartIdColumnToLetter(col) {
  let letter = "";
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

// ── Live trigger ─────────────────────────────────────────────────────────────
// NOTE: do NOT rename this to onEdit if another file already defines onEdit.
// If there's no other onEdit in the project, this name is required for the
// simple trigger to fire. If there IS one, call smartIdOnEdit(e) from inside it.
function onEdit(e) {
  if (!e || !e.range) return;
  const range = e.range;
  const sheet = range.getSheet();
  if (sheet.getName() !== SMARTID_CFG.scheduleSheet) return;

  // Act only if the Driver column falls within the edited block. This covers
  // both a single dropdown pick AND a multi-row/multi-col paste over column F.
  if (SMARTID_CFG.driverCol < range.getColumn() ||
      SMARTID_CFG.driverCol > range.getLastColumn()) return;

  // Clamp to data rows (never touch the header on row 1).
  const startRow = Math.max(range.getRow(), 2);
  const endRow = range.getRow() + range.getNumRows() - 1;
  if (endRow < startRow) return;
  const numRows = endRow - startRow + 1;

  const lookup = smartIdBuildLookup();
  if (!lookup) {
    SpreadsheetApp.getActive().toast('Sheet "' + SMARTID_CFG.masterSheet + '" not found', "⚠️ config", 5);
    return;
  }

  // Read every edited row's Driver cell, resolve, write the whole column back
  // in one setValues call (fast even for a large paste).
  const driverVals = sheet.getRange(startRow, SMARTID_CFG.driverCol, numRows, 1).getDisplayValues();
  const out = [];
  const missing = [];
  driverVals.forEach(r => {
    const result = smartIdResolveRow(r[0], lookup);
    out.push([result ? result.ids : ""]);
    if (result && result.missing.length) missing.push.apply(missing, result.missing);
  });

  sheet.getRange(startRow, SMARTID_CFG.outputCol, numRows, 1).setValues(out);

  if (missing.length) {
    SpreadsheetApp.getActive().toast("No ID for: " + [...new Set(missing)].join(", "), "⚠️ config", 5);
  }
}

// ── One-off bulk validation ──────────────────────────────────────────────────
// Run from the Apps Script editor (Run button) or a menu item. Previews every
// row into outputCol at once so you can eyeball results before flipping to K.
function validateAllSmartIds() {
  const ss = SpreadsheetApp.getActive();

  const allSheets = ss.getSheets().map(s => s.getName());
  Logger.log("Sheets in this spreadsheet: %s", JSON.stringify(allSheets));

  const sheet = ss.getSheetByName(SMARTID_CFG.scheduleSheet);
  if (!sheet) {
    Logger.log('❌ Schedule sheet "%s" NOT FOUND. Tab names above — fix SMARTID_CFG.scheduleSheet.', SMARTID_CFG.scheduleSheet);
    return;
  }

  const lookup = smartIdBuildLookup();
  if (!lookup) {
    Logger.log('❌ Master sheet "%s" NOT FOUND. Fix SMARTID_CFG.masterSheet.', SMARTID_CFG.masterSheet);
    return;
  }
  Logger.log("Lookup built: %s driver names loaded from '%s'", Object.keys(lookup).length, SMARTID_CFG.masterSheet);

  const lastRow = sheet.getLastRow();
  Logger.log("Schedule lastRow=%s, reading col %s (driver)", lastRow, SMARTID_CFG.driverCol);
  if (lastRow < 2) { Logger.log("❌ No data rows."); return; }

  const driverVals = sheet.getRange(2, SMARTID_CFG.driverCol, lastRow - 1, 1).getDisplayValues();
  const out = [];
  const problems = [];
  let multi = 0, single = 0, populated = 0;

  driverVals.forEach((r, i) => {
    const raw = r[0];
    const parts = String(raw || "").split(/,|\n/).map(s => s.trim()).filter(String);
    if (i < 3) Logger.log("Row %s raw=%s → split into %s: %s", i + 2, JSON.stringify(raw), parts.length, JSON.stringify(parts));

    const result = smartIdResolveRow(raw, lookup);
    if (result) { multi++; if (result.ids) populated++; } else if (parts.length <= 1 && raw) { single++; }

    out.push([result ? result.ids : ""]);
    if (result && result.missing.length) {
      problems.push("Row " + (i + 2) + ": " + result.missing.join(", "));
    }
  });

  sheet.getRange(2, SMARTID_CFG.outputCol, out.length, 1).setValues(out);
  SpreadsheetApp.flush();  // commit the write before returning

  const colLetter = smartIdColumnToLetter(SMARTID_CFG.outputCol);
  Logger.log("✅ Wrote %s rows to col %s. multi-driver=%s, single=%s, populated-with-ids=%s, unmatched-rows=%s",
    out.length, colLetter, multi, single, populated, problems.length);
  if (problems.length) Logger.log("Unmatched: %s", problems.join(" | "));
  // No blocking alert() — it hangs when run from the editor (no dialog to click).
  // Non-blocking toast instead; shows if the sheet is open, harmlessly skipped otherwise.
  SpreadsheetApp.getActive().toast(
    populated + " row(s) populated in col " + colLetter +
    (problems.length ? " · " + problems.length + " unmatched (see log)" : ""),
    "Smart IDs validated", 6
  );
}
