/**
 * Read-only access to the config spreadsheet via its public CSV export — the
 * same mechanism the dashboard uses (dashboard/src/lib/sheets.ts), so no
 * credentials are needed. Writes go through the Apps Script web app or the
 * dashboard API; nothing here mutates the sheet.
 */

export const SHEET_ID = "1Bqsm5atLYUQ4gMsL7zHrbrS6YUu7pEDa-Iy_j_wpCss";

export const GID = {
  drivers: "467715355",
  nghi_phep: "158238549",
};

/** Tab read by name rather than gid — it may not exist yet, and a hand-created
 *  tab gets a gid we can't know in advance. */
export const PT_PATTERN_SHEET = "PT Shift Pattern";

/** Full RFC-4180 CSV parse: quoted fields may contain commas AND newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else if (ch !== "\r") cur += ch;
  }
  if (cur !== "" || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

/** Header-keyed objects from a parsed CSV. First occurrence of a header wins. */
function toObjects(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((f) => {
    const o = {};
    headers.forEach((h, i) => {
      if (!(h in o)) o[h] = (f[i] ?? "").trim();
    });
    return o;
  });
}

async function fetchCsv(url) {
  // Cache-bust: Google's CDN serves a stale copy of the export URL for minutes.
  const res = await fetch(`${url}&_cb=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`sheet fetch failed: HTTP ${res.status}`);
  return toObjects(parseCsv(await res.text()));
}

export function byGid(gid) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
}

export function byName(sheetName) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(sheetName)}`;
}

const isFalsey = (v) => ["false", "0", "no"].includes((v || "").trim().toLowerCase());

/**
 * The Driver tab: the bridge between MISA and Cartrack. `employee_code` holds
 * the MISA code (DC…/PT…), `Driver` is the label the Nghỉ phép sheet's
 * xlookup resolves to a driver_id, and `delivery_driver_id` is the Cartrack UUID.
 */
export async function loadDrivers() {
  const rows = await fetchCsv(byGid(GID.drivers));
  return rows
    .map((r) => ({
      label: (r["Driver"] || "").trim(),
      driver_id: (r["delivery_driver_id"] || "").trim(),
      employee_code: (r["employee_code"] || "").trim(),
      employee_name: (r["employee_full_name"] || "").trim(),
      active: !isFalsey(r["is_active"]),
    }))
    .filter((d) => d.driver_id);
}

/** employee_code → driver row, active drivers only (a deactivated account can
 *  never take a job, so it has no place on a roster). */
export function driversByEmployeeCode(drivers) {
  const map = new Map();
  for (const d of drivers) {
    if (!d.employee_code || !d.active) continue;
    if (!map.has(d.employee_code)) map.set(d.employee_code, d);
  }
  return map;
}

const DAY_COLS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]; // index = getUTCDay()

/** "06:00-15:00" / "6:00 - 15:00" / "OFF" / "" → {start,end} or null for off. */
function parseWindow(cell) {
  const v = (cell || "").trim();
  if (!v || /^(off|nghỉ|nghi|-)$/i.test(v)) return null;
  const m = v.match(/^(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const pad = (h, mm) => `${String(Number(h)).padStart(2, "0")}:${mm}`;
  return { start: pad(m[1], m[2]), end: pad(m[3], m[4]) };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateCell(v) {
  const s = (v || "").trim();
  if (ISO_DATE.test(s)) return s;
  // Sheets may hand back d/m/yyyy depending on the cell's locale formatting.
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

/**
 * Weekly recurring patterns for staff with no MISA shift data (part-timers who
 * have no AMIS access). One column per weekday holding "HH:MM-HH:MM" or
 * blank/OFF.
 *
 * Effective-dated, so a person can have several rows: `active_from` is the day
 * the pattern takes effect and `active_to` the last day it applies (blank =
 * still current). Changing someone's hours means adding a row, not editing the
 * old one — which keeps the history and lets a change be entered ahead of time.
 * A blank `active_from` means "always", so a single-row-per-person sheet works
 * unchanged.
 *
 * Returns null when the tab does not exist yet, so the pipeline still runs.
 */
export async function loadPtPatterns() {
  let rows;
  try {
    rows = await fetchCsv(byName(PT_PATTERN_SHEET));
  } catch {
    return null; // tab missing — caller warns
  }
  const out = [];
  for (const r of rows) {
    const label = (r["driver"] || r["Driver"] || "").trim();
    const code = (r["employee_code"] || "").trim();
    if (!label && !code) continue;
    if (isFalsey(r["active"])) continue; // optional legacy kill-switch column
    const days = DAY_COLS.map((c) => parseWindow(r[c]));
    out.push({
      label,
      employee_code: code,
      days,
      active_from: parseDateCell(r["active_from"]),
      active_to: parseDateCell(r["active_to"]),
      note: (r["note"] || "").trim(),
    });
  }
  return out;
}

/** The pattern in force for `date`: latest active_from that has started and has
 *  not been superseded or ended. Null when the person isn't rostered that day. */
function patternOn(versions, date) {
  let best = null;
  for (const v of versions) {
    if (v.active_from && date < v.active_from) continue; // not started yet
    if (v.active_to && date > v.active_to) continue; // already ended
    if (!best) {
      best = v;
      continue;
    }
    // Later start wins; a dated row beats an undated "always" row.
    const a = v.active_from ?? "";
    const b = best.active_from ?? "";
    if (a >= b) best = v;
  }
  return best;
}

/**
 * Expand weekly patterns into the same per-day record shape MISA produces, for
 * every date in the month. People already covered by MISA are skipped —
 * `skipCodes` carries their employee codes so a person who exists in both
 * sources is not rostered twice.
 */
export function expandPtPatterns(patterns, range, skipCodes = new Set()) {
  // Group a person's pattern versions together.
  const byPerson = new Map();
  for (const p of patterns) {
    const key = p.employee_code || p.label;
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key).push(p);
  }

  const records = [];
  const start = new Date(range.monthStart + "T00:00:00Z");
  const end = new Date(range.monthEnd + "T00:00:00Z");

  for (const [key, versions] of byPerson) {
    if (skipCodes.has(key)) continue;
    const label = versions[0].label;
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const date = d.toISOString().slice(0, 10);
      const p = patternOn(versions, date);
      if (!p) continue; // before they started, or after they left — no row at all
      const win = p.days[d.getUTCDay()];
      records.push({
        employee_code: p.employee_code || label,
        full_name: label,
        shift_date: date,
        slot: 1,
        day_type: win ? "working" : "off",
        start_time: win ? win.start : null,
        end_time: win ? win.end : null,
        holiday_name: null,
        leave_start: null,
        leave_end: null,
        leave_gap: false,
        source: "PT",
      });
    }
  }
  return records;
}

/**
 * Leave already recorded in the Nghỉ phép tab — the engine's actual source of
 * truth. Used to overlay leave onto the grid for everyone, including part-timers
 * MISA knows nothing about. Returns a Map of "label|YYYY-MM-DD" → leave label.
 */
export async function loadSheetLeave() {
  const rows = await fetchCsv(byGid(GID.nghi_phep));
  const map = new Map();
  for (const r of rows) {
    const label = (r["driver"] || "").trim();
    const from = (r["leave_from"] || "").trim();
    if (!label || !/^\d{4}-\d{2}-\d{2}$/.test(from)) continue;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(r["leave_to"] || "") ? r["leave_to"].trim() : from;
    const type = (r["Loại Nghỉ"] || "").trim();
    const hrFrom = (r["leave_from_hr"] || "").trim();
    const hrTo = (r["leave_to_hr"] || "").trim();
    const tag = hrFrom && hrTo ? `${hrFrom}-${hrTo}` : type || "Nghỉ";

    // "Nghỉ việc" is open-ended (resigned) — cap the walk at the month end.
    const end = type === "Nghỉ việc" ? to : to;
    for (let d = new Date(from + "T00:00:00Z"), i = 0; i < 400; d.setUTCDate(d.getUTCDate() + 1), i++) {
      const ds = d.toISOString().slice(0, 10);
      if (ds > end) break;
      map.set(`${label}|${ds}`, tag);
    }
  }
  return map;
}
