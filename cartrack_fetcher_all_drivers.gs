/**
 * Cartrack Fleet API - Combined Location & Driver Data Fetcher
 * Includes offline ward lookup via wards_data.gs (WARDS_DATA variable)
 * Includes new location export with export_status tracking
 * Includes nearest_dropoff column (col 9) — nearest PSC by Haversine distance
 * Includes lat/lng columns (col 10, 11) — from Cartrack API
 * dropoff_id (col F) is managed as a single ArrayFormula — not tracked by script
 *
 * Driver Table (16 cols A–P):
 *   A  Driver                      — first_name + last_name (full, from Cartrack)
 *   B  delivery_driver_id          — Cartrack UUID
 *   C  driver_zalo_id              — PRESERVED across fetches
 *   D  bot_token                   — PRESERVED across fetches
 *   E  employee_code               — regex extract PT/DC + digits from col A
 *   F  employee_full_name          — last_name only from Cartrack
 *   G  email                       — Cartrack
 *   H  phone_code                  — Cartrack
 *   I  phone_number                — Cartrack
 *   J  phone_number_update         — PRESERVED across fetches (manual override)
 *   K  shift_time_start            — Cartrack
 *   L  shift_time_end              — Cartrack
 *   M  start_location_customer_id  — Cartrack
 *   N  end_location_customer_id    — Cartrack
 *   O  code_name                   — employee_code + " " + employee_full_name
 *   P  is_active                   — Cartrack active flag, WRITTEN PER DRIVER
 *
 * Only drivers with is_active === true are written to the sheet, so col P reads
 * TRUE on every row. It is written anyway, on every fetch, because the alternative
 * was what this sheet actually had: a column of TRUE/FALSE values entered once by
 * hand, never rewritten, while the driver rows below were cleared and re-fetched
 * around it. New drivers land near the top, everyone below shifts down, and each
 * row ends up reading the flag of whoever used to sit on that line — 85 of 174
 * active drivers were marked FALSE that way, and the dashboard's substitute picker
 * hides anyone marked FALSE. Writing the flag with its own row every time is what
 * makes that impossible.
 *
 * The clear step below now covers all 16 columns for the same reason: it sweeps
 * out any leftover values sitting below the last driver row.
 */

// ========== CONFIGURATION ==========
const API_CONFIG = {
  customersUrl: 'https://fleetapi-vn.cartrack.com/rest/delivery/customers',
  driversUrl:   'https://fleetapi-vn.cartrack.com/rest/delivery/drivers',
  // Secrets live in Script Properties (Project Settings -> Script Properties), not in this file:
  //   CARTRACK_AUTH   = Basic <base64 of user:password>
  //   CARTRACK_COOKIE = <session cookie value>
  authToken:    PropertiesService.getScriptProperties().getProperty('CARTRACK_AUTH'),
  cookie:       PropertiesService.getScriptProperties().getProperty('CARTRACK_COOKIE')
};

const LOCATION_SHEET_CONFIG = {
  sheetName: 'Location Table',
  headerRow: 1,
  startRow:  2,
  columns: {
    customerName:    1,
    customerId:      2,
    addressLine1:    3,
    newWard:         4,
    dropoff:         5,
    dropoffId:       6,
    eta:             7,
    exportStatus:    8,
    nearestDropoff:  9,
    lat:             10,
    lng:             11
  }
};

const DRIVER_SHEET_CONFIG = {
  sheetName: 'Driver',
  headerRow: 1,
  startRow:  2,
  columns: {
    driver:                    1,   // A
    deliveryDriverId:          2,   // B
    driverZaloId:              3,   // C  — preserved
    botToken:                  4,   // D  — preserved
    employeeCode:              5,   // E
    employeeFullName:          6,   // F
    email:                     7,   // G
    phoneCode:                 8,   // H
    phoneNumber:               9,   // I
    phoneNumberUpdate:         10,  // J  — preserved
    shiftTimeStart:            11,  // K
    shiftTimeEnd:              12,  // L
    startLocationCustomerId:   13,  // M
    endLocationCustomerId:     14,  // N
    codeName:                  15,  // O
    isActive:                  16   // P
  }
};

// ========== API FUNCTIONS ==========

function fetchCustomerData() {
  try {
    const options = {
      method: 'get',
      headers: {
        'Authorization': API_CONFIG.authToken,
        'Cookie': `CTSID=${API_CONFIG.cookie}`
      },
      muteHttpExceptions: true
    };
    const response   = UrlFetchApp.fetch(API_CONFIG.customersUrl, options);
    const statusCode = response.getResponseCode();
    if (statusCode !== 200) throw new Error(`Customer API failed: ${statusCode}`);
    return JSON.parse(response.getContentText()).data || [];
  } catch (e) {
    Logger.log('fetchCustomerData error: ' + e.message);
    throw e;
  }
}

function fetchDriverData() {
  try {
    const options = {
      method: 'get',
      headers: {
        'Authorization': API_CONFIG.authToken,
        'Cookie': `CTSID=${API_CONFIG.cookie}`
      },
      muteHttpExceptions: true
    };
    const response   = UrlFetchApp.fetch(API_CONFIG.driversUrl, options);
    const statusCode = response.getResponseCode();
    if (statusCode !== 200) throw new Error(`Driver API failed: ${statusCode}`);
    return JSON.parse(response.getContentText()).data || [];
  } catch (e) {
    Logger.log('fetchDriverData error: ' + e.message);
    throw e;
  }
}

// ========== OFFLINE WARD LOOKUP ==========

let _wardsCache = null;

function loadWardsData_() {
  if (_wardsCache !== null) return _wardsCache;
  _wardsCache = WARDS_DATA;
  Logger.log(`Ward data loaded: ${_wardsCache.length} wards`);
  return _wardsCache;
}

function pointInPolygon_(px, py, ring) {
  let inside = false;
  const n = ring.length;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi + 1e-10) + xi)) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}

function pointInMultiPolygon_(lng, lat, coordinates) {
  for (const polygon of coordinates) {
    if (pointInPolygon_(lng, lat, polygon[0])) {
      const inHole = polygon.slice(1).some(hole => pointInPolygon_(lng, lat, hole));
      if (!inHole) return true;
    }
  }
  return false;
}

function fetchNewWard(lat, lng) {
  if (!lat || !lng) return '';
  const latF = parseFloat(lat);
  const lngF = parseFloat(lng);
  if (isNaN(latF) || isNaN(lngF)) {
    Logger.log(`fetchNewWard: invalid coords (${lat}, ${lng})`);
    return '';
  }
  try {
    const wards = loadWardsData_();
    for (const ward of wards) {
      if (pointInMultiPolygon_(lngF, latF, ward.c)) return ward.n;
    }
    Logger.log(`fetchNewWard: no ward found for (${lat}, ${lng})`);
    return '';
  } catch (e) {
    Logger.log(`fetchNewWard error (${lat}, ${lng}): ${e.message}`);
    return '';
  }
}

// ========== NEAREST DROPOFF (PSC) ==========

function getPscList() {
  const SS_ID = '1Bqsm5atLYUQ4gMsL7zHrbrS6YUu7pEDa-Iy_j_wpCss';
  try {
    const ss    = SpreadsheetApp.openById(SS_ID);
    const sheet = ss.getSheetByName('PSC');
    if (!sheet) throw new Error('PSC sheet not found');

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();

    const pscs = [];
    data.forEach(row => {
      const code = String(row[0] || '').trim();
      const lat  = parseFloat(row[6]);
      const lng  = parseFloat(row[7]);
      if (code && !isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
        pscs.push({ code, lat, lng });
      }
    });

    Logger.log(`getPscList: loaded ${pscs.length} PSCs from sheet`);
    return pscs;

  } catch (e) {
    Logger.log('getPscList error: ' + e.message);
    return [];
  }
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearestPsc(lat, lng, pscs) {
  if (!lat || !lng || !pscs || pscs.length === 0) return '';
  let bestCode = '';
  let bestDist = Infinity;
  pscs.forEach(psc => {
    const d = haversineKm(parseFloat(lat), parseFloat(lng), psc.lat, psc.lng);
    if (d < bestDist) {
      bestDist = d;
      bestCode = psc.code;
    }
  });
  return bestCode;
}

// ========== LOCATION TABLE FUNCTIONS ==========

function setupLocationHeaders(sheet) {
  const headers     = [['customer_name', 'customer_id', 'address_line_1', 'new_ward',
                        'dropoff', 'dropoff_id', 'eta', 'export_status', 'nearest_dropoff',
                        'lat', 'lng']];
  const headerRange = sheet.getRange(LOCATION_SHEET_CONFIG.headerRow, 1, 1, 11);
  headerRange.setValues(headers);
  headerRange.setFontWeight('bold');
  headerRange.setHorizontalAlignment('left');
}

function getExistingLocationMeta(sheet) {
  const metaMap = {};
  const lastRow = sheet.getLastRow();
  if (lastRow < LOCATION_SHEET_CONFIG.startRow) return metaMap;

  const numRows = lastRow - LOCATION_SHEET_CONFIG.startRow + 1;
  // Only read cols A–H (8 cols) — col F (dropoff_id) is ArrayFormula, not tracked
  const values  = sheet.getRange(LOCATION_SHEET_CONFIG.startRow, 1, numRows, 8).getValues();

  values.forEach((row) => {
    const customerId = row[1];
    if (customerId) {
      metaMap[String(customerId)] = {
        newWard:      row[3] || '',
        dropoff:      row[4] || '',
        eta:          row[6] || '',
        exportStatus: row[7] || ''
      };
    }
  });

  Logger.log(`Loaded ${Object.keys(metaMap).length} existing location meta mappings`);
  return metaMap;
}

function updateLocationTable() {
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet       = spreadsheet.getSheetByName(LOCATION_SHEET_CONFIG.sheetName);
    if (!sheet) throw new Error(`Sheet "${LOCATION_SHEET_CONFIG.sheetName}" not found`);

    setupLocationHeaders(sheet);

    const existingMeta = getExistingLocationMeta(sheet);

    spreadsheet.toast('Fetching customer data...', 'Location', 2);
    const customers = fetchCustomerData();
    if (customers.length === 0) { Logger.log('No customer data found'); return 0; }

    spreadsheet.toast('Loading ward data...', 'Location', 2);
    loadWardsData_();

    spreadsheet.toast('Loading PSC list...', 'Location', 2);
    const pscList = getPscList();

    let skipped = 0;
    let fetched = 0;

    const mainData = [];

    customers.forEach(customer => {
      const customerId = String(customer.customer_id || '');
      const lat        = customer.latitude  || '';
      const lng        = customer.longitude || '';
      const meta       = existingMeta[customerId] || {};

      let newWard = meta.newWard || '';
      if (!newWard && lat && lng) {
        newWard = fetchNewWard(lat, lng);
        fetched++;
      } else {
        skipped++;
      }

      mainData.push([
        customer.customer_name  || '',       // A (1)
        customerId,                           // B (2)
        customer.address_line_1 || '',       // C (3)
        newWard,                              // D (4)
        meta.dropoff       || '',            // E (5)
        meta.eta           || '',            // F placeholder → written to col G
        meta.exportStatus  || '',            // G placeholder → written to col H
        findNearestPsc(lat, lng, pscList),   // H placeholder → written to col I
        lat ? parseFloat(lat) : '',          // I placeholder → written to col J
        lng ? parseFloat(lng) : ''           // J placeholder → written to col K
      ]);
    });

    // Clear cols A–E and G–K (skip col F — ArrayFormula lives there)
    const lastRow = sheet.getLastRow();
    if (lastRow >= LOCATION_SHEET_CONFIG.startRow) {
      const numExisting = lastRow - LOCATION_SHEET_CONFIG.startRow + 1;
      sheet.getRange(LOCATION_SHEET_CONFIG.startRow, 1, numExisting, 5).clearContent();  // A–E
      sheet.getRange(LOCATION_SHEET_CONFIG.startRow, 7, numExisting, 5).clearContent();  // G–K
    }

    if (mainData.length > 0) {
      // Write A–E (cols 1–5): customer_name, customer_id, address_line_1, new_ward, dropoff
      sheet.getRange(LOCATION_SHEET_CONFIG.startRow, 1, mainData.length, 5)
        .setValues(mainData.map(r => r.slice(0, 5)));

      // Col F — restore ArrayFormula if missing (e.g. first run or accidentally deleted)
      const f2 = sheet.getRange('F2').getFormula();
      if (!f2) {
        sheet.getRange('F2').setFormula(
          '=ARRAYFORMULA(IFNA(VLOOKUP(E2:E,\'Location Table\'!A:C,2,false),""))'
        );
      }

      // Write G (eta) — mainData index 5
      sheet.getRange(LOCATION_SHEET_CONFIG.startRow, 7, mainData.length, 1)
        .setValues(mainData.map(r => [r[5]]));

      // Write H (export_status) — mainData index 6
      sheet.getRange(LOCATION_SHEET_CONFIG.startRow, 8, mainData.length, 1)
        .setValues(mainData.map(r => [r[6]]));

      // Write I (nearest_dropoff) — mainData index 7
      sheet.getRange(LOCATION_SHEET_CONFIG.startRow, 9, mainData.length, 1)
        .setValues(mainData.map(r => [r[7]]));

      // Write J (lat) — mainData index 8
      sheet.getRange(LOCATION_SHEET_CONFIG.startRow, 10, mainData.length, 1)
        .setValues(mainData.map(r => [r[8]]));

      // Write K (lng) — mainData index 9
      sheet.getRange(LOCATION_SHEET_CONFIG.startRow, 11, mainData.length, 1)
        .setValues(mainData.map(r => [r[9]]));
    }

    sheet.autoResizeColumns(1, 11);
    Logger.log(`Updated ${customers.length} customers (${fetched} ward lookups, ${skipped} skipped)`);
    return customers.length;

  } catch (e) {
    Logger.log('updateLocationTable error: ' + e.message);
    throw e;
  }
}

function refreshAllWards() {
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet       = spreadsheet.getSheetByName(LOCATION_SHEET_CONFIG.sheetName);
    if (!sheet) throw new Error(`Sheet "${LOCATION_SHEET_CONFIG.sheetName}" not found`);

    const lastRow = sheet.getLastRow();
    if (lastRow < LOCATION_SHEET_CONFIG.startRow) {
      spreadsheet.toast('No data to refresh.', 'Wards', 3);
      return;
    }

    spreadsheet.toast('Loading ward data...', 'Wards', 2);
    loadWardsData_();

    const customers = fetchCustomerData();
    const coordMap  = {};
    customers.forEach(c => {
      if (c.customer_id) {
        coordMap[c.customer_id] = { lat: c.latitude || '', lng: c.longitude || '' };
      }
    });

    const numRows = lastRow - LOCATION_SHEET_CONFIG.startRow + 1;
    const data    = sheet.getRange(LOCATION_SHEET_CONFIG.startRow, 1, numRows, 4).getValues();

    let refreshed = 0;
    data.forEach((row, i) => {
      const coords = coordMap[row[1]];
      if (coords && coords.lat && coords.lng) {
        const newWard = fetchNewWard(coords.lat, coords.lng);
        sheet.getRange(LOCATION_SHEET_CONFIG.startRow + i, 4).setValue(newWard);
        refreshed++;
      }
    });

    spreadsheet.toast(`✅ Refreshed ${refreshed} ward values.`, 'Wards', 5);
    Logger.log(`Refreshed ${refreshed} wards`);

  } catch (e) {
    SpreadsheetApp.getActiveSpreadsheet().toast('❌ Error: ' + e.message, 'Error', 10);
    Logger.log('refreshAllWards error: ' + e.message);
    throw e;
  }
}

function fillMissingWards() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet       = spreadsheet.getSheetByName(LOCATION_SHEET_CONFIG.sheetName);
  if (!sheet) throw new Error(`Sheet "${LOCATION_SHEET_CONFIG.sheetName}" not found`);

  const lastRow = sheet.getLastRow();
  if (lastRow < LOCATION_SHEET_CONFIG.startRow) {
    spreadsheet.toast('No data found.', 'Fill Wards', 3);
    return;
  }

  spreadsheet.toast('Loading ward data...', 'Fill Wards', 2);
  loadWardsData_();

  const numRows   = lastRow - LOCATION_SHEET_CONFIG.startRow + 1;
  const values    = sheet.getRange(LOCATION_SHEET_CONFIG.startRow, 1, numRows, 4).getValues();
  const customers = fetchCustomerData();

  const coordMap = {};
  customers.forEach(c => {
    if (c.customer_id) {
      coordMap[String(c.customer_id)] = { lat: c.latitude || '', lng: c.longitude || '' };
    }
  });

  let filled = 0, skipped = 0, noCoords = 0, notFound = 0;

  values.forEach((row, i) => {
    const customerId = String(row[1]);
    const ward       = row[3];
    if (ward) { skipped++; return; }
    const coords = coordMap[customerId] || {};
    if (!coords.lat || !coords.lng) { noCoords++; return; }
    const newWard = fetchNewWard(coords.lat, coords.lng);
    if (newWard) {
      sheet.getRange(LOCATION_SHEET_CONFIG.startRow + i, 4).setValue(newWard);
      filled++;
    } else {
      notFound++;
      Logger.log(`fillMissingWards: no result for row ${LOCATION_SHEET_CONFIG.startRow + i} (${customerId})`);
    }
  });

  const summary = `✅ Filled: ${filled} | Skipped: ${skipped} | No coords: ${noCoords} | Not found: ${notFound}`;
  spreadsheet.toast(summary, 'Fill Wards Complete', 8);
  Logger.log(summary);
}

// ========== DRIVER TABLE FUNCTIONS ==========

function setupDriverHeaders(sheet) {
  const headers = [['Driver', 'delivery_driver_id', 'driver_zalo_id', 'bot_token',
                    'employee_code', 'employee_full_name', 'email',
                    'phone_code', 'phone_number', 'phone_number_update',
                    'shift_time_start', 'shift_time_end',
                    'start_location_customer_id', 'end_location_customer_id',
                    'code_name', 'is_active']];
  const headerRange = sheet.getRange(DRIVER_SHEET_CONFIG.headerRow, 1, 1, 16);
  headerRange.setValues(headers);
  headerRange.setFontWeight('bold');
  headerRange.setHorizontalAlignment('left');
}

function formatDriverName(firstName, lastName) {
  return ((firstName || '') + ' ' + (lastName || '')).trim();
}

function extractEmployeeCode(driverName) {
  const match = driverName.match(/((?:PT|DC)\d+)/);
  return match ? match[1] : '';
}

function getExistingDriverMeta(sheet) {
  const metaMap = {};
  const lastRow = sheet.getLastRow();
  if (lastRow < DRIVER_SHEET_CONFIG.startRow) return metaMap;

  // Read up to col J (10 cols) to capture phone_number_update (index 9)
  const data = sheet.getRange(
    DRIVER_SHEET_CONFIG.startRow, 1,
    lastRow - DRIVER_SHEET_CONFIG.startRow + 1, 10
  ).getValues();

  data.forEach(row => {
    if (row[1]) {
      metaMap[row[1]] = {
        driverZaloId:      row[2] || '',   // C
        botToken:          row[3] || '',   // D
        phoneNumberUpdate: row[9] || ''    // J
      };
    }
  });

  Logger.log(`Loaded ${Object.keys(metaMap).length} existing driver meta mappings`);
  return metaMap;
}

function updateDriverTable() {
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet       = spreadsheet.getSheetByName(DRIVER_SHEET_CONFIG.sheetName);
    if (!sheet) throw new Error(`Sheet "${DRIVER_SHEET_CONFIG.sheetName}" not found`);

    const existingMeta = getExistingDriverMeta(sheet);

    spreadsheet.toast('Fetching driver data...', 'Driver', 2);
    const allDrivers = fetchDriverData();
    if (allDrivers.length === 0) { Logger.log('No driver data found'); return 0; }

    // Filter active drivers only.
    // To list inactive accounts too (col P then carries the real TRUE/FALSE and
    // the dashboard picker hides the FALSE ones), replace the line below with:
    //   const drivers = allDrivers;
    const drivers = allDrivers.filter(d => d.is_active === true);
    Logger.log(`Filtered to ${drivers.length} active drivers (from ${allDrivers.length} total)`);

    setupDriverHeaders(sheet);

    const dataToWrite = drivers.map(driver => {
      const id           = driver.delivery_driver_id || '';
      const meta         = existingMeta[id] || {};
      const fullName     = formatDriverName(driver.first_name, driver.last_name);
      const employeeName = (driver.last_name || '').trim();  // employee_full_name = last_name only
      const employeeCode = extractEmployeeCode(fullName);
      const codeName     = employeeCode && employeeName
                           ? employeeCode + ' ' + employeeName
                           : employeeCode || employeeName;

      return [
        fullName,                                    // A  - Driver
        id,                                          // B  - delivery_driver_id
        meta.driverZaloId      || '',                // C  - driver_zalo_id       (preserved)
        meta.botToken          || '',                // D  - bot_token             (preserved)
        employeeCode,                                // E  - employee_code
        employeeName,                                // F  - employee_full_name
        driver.email                      || '',     // G  - email
        driver.phone_code                 || '',     // H  - phone_code
        driver.phone_number               || '',     // I  - phone_number
        meta.phoneNumberUpdate            || '',     // J  - phone_number_update   (preserved)
        driver.shift_time_start           || '',     // K  - shift_time_start
        driver.shift_time_end             || '',     // L  - shift_time_end
        driver.start_location_customer_id || '',     // M  - start_location_customer_id
        driver.end_location_customer_id   || '',     // N  - end_location_customer_id
        codeName,                                    // O  - code_name
        driver.is_active == null ? '' : driver.is_active // P  - is_active
      ];
    });

    // Clear all 16 cols before rewrite
    const lastRow = sheet.getLastRow();
    if (lastRow >= DRIVER_SHEET_CONFIG.startRow) {
      sheet.getRange(
        DRIVER_SHEET_CONFIG.startRow, 1,
        lastRow - DRIVER_SHEET_CONFIG.startRow + 1, 16
      ).clearContent();
    }

    if (dataToWrite.length > 0) {
      sheet.getRange(DRIVER_SHEET_CONFIG.startRow, 1, dataToWrite.length, 16)
        .setValues(dataToWrite);
    }

    sheet.autoResizeColumns(1, 16);
    Logger.log(`Updated ${drivers.length} active drivers`);
    return drivers.length;

  } catch (e) {
    Logger.log('updateDriverTable error: ' + e.message);
    throw e;
  }
}

// ========== COMBINED UPDATE ==========

function updateAllTables() {
  try {
    const start = new Date();
    SpreadsheetApp.getActiveSpreadsheet().toast('Starting full data fetch...', 'Status', 3);

    const customerCount = updateLocationTable();
    const driverCount   = updateDriverTable();

    const elapsed = ((new Date() - start) / 1000).toFixed(1);
    SpreadsheetApp.getActiveSpreadsheet().toast(
      `✅ Done! ${customerCount} customers, ${driverCount} drivers in ${elapsed}s`,
      'Complete', 5
    );

    Logger.log(`=== Update Complete: ${customerCount} customers, ${driverCount} drivers, ${elapsed}s ===`);

  } catch (e) {
    SpreadsheetApp.getActiveSpreadsheet().toast('❌ Error: ' + e.message, 'Error', 10);
    Logger.log('updateAllTables error: ' + e.message);
    throw e;
  }
}

// ========== DIAGNOSTICS ==========

function testOfflineLookup() {
  const tests = [
    { lat: 10.760003, lng: 106.676995, label: 'Quận 10 HCMC'  },
    { lat: 10.845276, lng: 106.727625, label: 'Thủ Đức HBinh' },
    { lat: 16.030263, lng: 107.904724, label: 'Huế area'       },
  ];

  const start = new Date();
  Logger.log('=== Offline Ward Lookup Test ===');
  tests.forEach(t => {
    const ward = fetchNewWard(t.lat, t.lng);
    Logger.log(`  ${t.label} => "${ward || '(not found)'}"`);
  });
  const elapsed = ((new Date() - start) / 1000).toFixed(2);
  Logger.log(`Done in ${elapsed}s`);

  SpreadsheetApp.getActiveSpreadsheet().toast(
    `Test done in ${elapsed}s — check Apps Script logs.`, 'Ward Test', 6
  );
}

function testPscList() {
  const pscs = getPscList();
  Logger.log(`=== PSC List Test ===`);
  Logger.log(`Loaded ${pscs.length} PSCs`);
  pscs.slice(0, 5).forEach(p => Logger.log(`  ${p.code} | lat=${p.lat} | lng=${p.lng}`));

  const nearest = findNearestPsc(10.858, 106.748, pscs);
  Logger.log(`Nearest PSC to Thủ Đức (10.858, 106.748): ${nearest}`);

  SpreadsheetApp.getActiveSpreadsheet().toast(
    `Loaded ${pscs.length} PSCs. Nearest to Thủ Đức: ${nearest} — check logs.`, 'PSC Test', 6
  );
}

function diagnoseMissingWards() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet       = spreadsheet.getSheetByName(LOCATION_SHEET_CONFIG.sheetName);
  if (!sheet) { Logger.log('Location Table not found'); return; }

  const lastRow = sheet.getLastRow();
  if (lastRow < LOCATION_SHEET_CONFIG.startRow) { Logger.log('Sheet is empty'); return; }

  const numRows = lastRow - LOCATION_SHEET_CONFIG.startRow + 1;
  const values  = sheet.getRange(LOCATION_SHEET_CONFIG.startRow, 1, numRows, 4).getValues();

  const customers = fetchCustomerData();
  const coordMap  = {};
  customers.forEach(c => {
    if (c.customer_id) {
      coordMap[String(c.customer_id)] = { lat: c.latitude || '', lng: c.longitude || '' };
    }
  });

  const missing = values
    .map((row, i) => ({ row: LOCATION_SHEET_CONFIG.startRow + i, id: String(row[1]), name: row[0], ward: row[3] }))
    .filter(r => !r.ward);

  Logger.log(`\n=== Missing Ward Diagnosis ===`);
  Logger.log(`Total rows: ${numRows} | Missing wards: ${missing.length}`);

  missing.forEach(m => {
    const coords   = coordMap[m.id] || {};
    const hasCoord = !!(coords.lat && coords.lng);
    Logger.log(`Row ${m.row} | ${m.id} | ${m.name} | ${hasCoord ? `lat=${coords.lat}, lng=${coords.lng}` : 'NO COORDINATES'}`);
  });

  spreadsheet.toast(
    `${missing.length} rows missing wards — check Apps Script logs.`, 'Diagnosis', 8
  );
}

// ========== MENU ==========

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🚀 Fetch Data')
    .addItem('📍 Fetch Locations from Cartrack', 'updateLocationTable')
    .addItem('🛵 Fetch Drivers from Cartrack',  'updateDriverTable')
    .addItem('📅 Fetch Driver Shifts from MISA', 'updateDriverShiftTable')
    .addToUi();
}

// ========== HELPER FUNCTIONS ==========

function showScheduleDialog() {
  const html = HtmlService.createHtmlOutput(`
    <div style="font-family: Arial, sans-serif; padding: 10px;">
      <h3>Setup Automatic Sync</h3>
      <ol>
        <li>Go to <b>Extensions</b> > <b>Apps Script</b></li>
        <li>Click the <b>clock icon ⏰</b> (Triggers)</li>
        <li>Click <b>+ Add Trigger</b></li>
        <li>Configure:
          <ul>
            <li><b>Function:</b> updateAllTables</li>
            <li><b>Event source:</b> Time-driven</li>
            <li><b>Type:</b> Day timer</li>
          </ul>
        </li>
        <li>Click <b>Save</b></li>
      </ol>
      <p><i>Ward data is resolved offline — no API token or sleep delays needed.</i></p>
      <p><i>dropoff, eta, and export_status are always preserved across every fetch.</i></p>
      <p><i>dropoff_id is managed as an ArrayFormula in col F — not tracked by the script.</i></p>
      <p><i>nearest_dropoff, lat, and lng are recalculated fresh on every fetch.</i></p>
      <p><i>driver_zalo_id, bot_token, and phone_number_update are preserved across every driver fetch.</i></p>
      <p><i>Only active drivers (is_active = true) are written to the Driver sheet, and col P (is_active) is rewritten with each driver every fetch — never left standing while the rows move.</i></p>
    </div>
  `).setWidth(400).setHeight(440);
  SpreadsheetApp.getUi().showModalDialog(html, 'Setup Auto-Sync');
}

function testAPIConnection() {
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    spreadsheet.toast('Testing API connections...', 'Testing', 3);

    const customers = fetchCustomerData();
    Logger.log(`✅ Customer API: ${customers.length} customers`);

    const drivers = fetchDriverData();
    const activeDrivers = drivers.filter(d => d.is_active === true);
    Logger.log(`✅ Driver API: ${drivers.length} total, ${activeDrivers.length} active`);

    const sample = customers.find(c => c.latitude && c.longitude);
    if (sample) {
      const ward = fetchNewWard(sample.latitude, sample.longitude);
      Logger.log(`✅ Offline ward: "${ward}" for (${sample.latitude}, ${sample.longitude})`);
    }

    const pscs = getPscList();
    Logger.log(`✅ PSC list: ${pscs.length} PSCs loaded`);

    spreadsheet.toast(
      `✅ All OK! ${customers.length} customers, ${activeDrivers.length} active drivers, ${pscs.length} PSCs`,
      'Test Result', 5
    );
  } catch (e) {
    SpreadsheetApp.getActiveSpreadsheet().toast('❌ Failed: ' + e.message, 'Test Result', 10);
  }
}

function clearLocationTable() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(LOCATION_SHEET_CONFIG.sheetName);
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow >= LOCATION_SHEET_CONFIG.startRow) {
    // Skip col F (ArrayFormula) — clear A–E and G–K only
    const numRows = lastRow - LOCATION_SHEET_CONFIG.startRow + 1;
    sheet.getRange(LOCATION_SHEET_CONFIG.startRow, 1,  numRows, 5).clearContent(); // A–E
    sheet.getRange(LOCATION_SHEET_CONFIG.startRow, 7,  numRows, 5).clearContent(); // G–K
  }
  SpreadsheetApp.getActiveSpreadsheet().toast('Location Table cleared', 'Success', 3);
}

function clearDriverTable() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(DRIVER_SHEET_CONFIG.sheetName);
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow >= DRIVER_SHEET_CONFIG.startRow) {
    sheet.getRange(
      DRIVER_SHEET_CONFIG.startRow, 1,
      lastRow - DRIVER_SHEET_CONFIG.startRow + 1, 16  // updated to 16 cols
    ).clearContent();
  }
  SpreadsheetApp.getActiveSpreadsheet().toast('Driver table cleared', 'Success', 3);
}

function initialSetup() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const ls = spreadsheet.getSheetByName(LOCATION_SHEET_CONFIG.sheetName);
  if (ls) {
    setupLocationHeaders(ls);
    // Set the ArrayFormula for dropoff_id on first setup
    ls.getRange('F2').setFormula(
      '=ARRAYFORMULA(IFNA(VLOOKUP(E2:E,\'Location Table\'!A:C,2,false),""))'
    );
  }
  const ds = spreadsheet.getSheetByName(DRIVER_SHEET_CONFIG.sheetName);
  if (ds) setupDriverHeaders(ds);
  spreadsheet.toast('Headers and ArrayFormula created!', 'Success', 3);
}

function debugMetaMatch() {
  const sheet        = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(LOCATION_SHEET_CONFIG.sheetName);
  const existingMeta = getExistingLocationMeta(sheet);

  Logger.log('=== Existing Location Meta (first 5) ===');
  Object.entries(existingMeta).slice(0, 5).forEach(([id, meta]) => {
    Logger.log(`  ${id} | ward: "${meta.newWard}" | dropoff: "${meta.dropoff}" | eta: "${meta.eta}" | exportStatus: "${meta.exportStatus}"`);
  });

  const customers = fetchCustomerData();
  Logger.log('=== API Customer IDs (first 5) ===');
  customers.slice(0, 5).forEach(c => {
    const id    = String(c.customer_id || '');
    const match = existingMeta[id];
    Logger.log(`  ${id} | match: ${!!match} | dropoff: "${match ? match.dropoff : 'N/A'}"`);
  });
}

function debugDriverMeta() {
  const sheet        = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(DRIVER_SHEET_CONFIG.sheetName);
  const existingMeta = getExistingDriverMeta(sheet);

  Logger.log('=== Existing Driver Meta (first 5) ===');
  Object.entries(existingMeta).slice(0, 5).forEach(([id, meta]) => {
    Logger.log(`  ${id} | zaloId: "${meta.driverZaloId}" | botToken: "${meta.botToken ? '***' : ''}" | phoneUpdate: "${meta.phoneNumberUpdate}"`);
  });

  const allDrivers   = fetchDriverData();
  const activeDrivers = allDrivers.filter(d => d.is_active === true);
  Logger.log(`=== API Drivers: ${allDrivers.length} total, ${activeDrivers.length} active ===`);
  activeDrivers.slice(0, 5).forEach(d => {
    const id    = d.delivery_driver_id || '';
    const match = existingMeta[id];
    const name  = formatDriverName(d.first_name, d.last_name);
    Logger.log(`  ${id} | ${name} | code: "${extractEmployeeCode(name)}" | meta match: ${!!match}`);
  });
}
