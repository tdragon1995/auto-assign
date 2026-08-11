/**
 * Pure parsing: MISA API payloads → sheet rows + normalized Supabase records.
 * Direct port of the proven Apps Script logic (misaParseShifts_ / misaBuildLeaveMap_).
 *
 * All date math assumes process.env.TZ === "Asia/Ho_Chi_Minh" (set by the entrypoint).
 */

/**
 * First/last instant of a span of VN months, as the UTC ISO strings MISA
 * expects. Defaults to the current month; pass "YYYY-MM" to start elsewhere and
 * `months` to cover more than one (2 = this month and next, so next month's
 * roster and booked-ahead leave are visible while there is still time to
 * arrange cover).
 */
export function monthRange(now = new Date(), month = null, months = 1) {
  let y, m;
  if (month) {
    const [ys, ms] = month.split("-").map(Number);
    if (!ys || !ms || ms < 1 || ms > 12) throw new Error(`bad --month value: ${month}`);
    y = ys;
    m = ms - 1;
  } else {
    y = now.getFullYear();
    m = now.getMonth();
  }
  const span = Math.max(1, Number(months) || 1);

  // VN midnight = 17:00 previous day UTC
  const first = new Date(Date.UTC(y, m, 1, -7, 0, 0, 0));
  const last = new Date(Date.UTC(y, m + span, 0, 16, 59, 59, 999));
  const lastLocal = new Date(y, m + span, 0);

  // Every calendar year the span touches — the attendance endpoint filters by
  // year, so a Dec→Jan span has to query both.
  const years = [];
  for (let i = 0; i < span; i++) {
    const yr = new Date(y, m + i, 1).getFullYear();
    if (!years.includes(yr)) years.push(yr);
  }

  return {
    fromDate: first.toISOString(),
    toDate: last.toISOString(),
    year: y,
    years,
    months: span,
    monthStart: `${y}-${String(m + 1).padStart(2, "0")}-01`,
    monthEnd: isoDay(lastLocal),
  };
}

function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "2026_7_3" → "2026-07-03" */
function formatDateKey(key) {
  const p = key.split("_");
  return `${p[0]}-${String(parseInt(p[1], 10)).padStart(2, "0")}-${String(parseInt(p[2], 10)).padStart(2, "0")}`;
}

const extractIsoDate = (iso) => (iso ? iso.substring(0, 10) : "");
const extractIsoTime = (iso) => (iso && iso.length >= 16 ? iso.substring(11, 16) : "");

function enumerateDates(startStr, endStr) {
  const dates = [];
  const start = new Date(startStr + "T00:00:00Z");
  const end = new Date(endStr + "T00:00:00Z");
  for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().substring(0, 10));
  }
  return dates;
}

/**
 * Attendance records → { "EMPLOYEE_CODE|YYYY-MM-DD": { start, end } }.
 * Prefers the per-date AttendanceData breakdown (excludes weekends/holidays);
 * multi-day leaves get 00:00/23:59 boundaries on middle days.
 */
export function buildLeaveMap(attendanceRows) {
  const map = {};
  for (const att of attendanceRows) {
    const code = att.EmployeeCode;
    const fromIso = att.FromDate || "";
    const toIso = att.ToDate || "";
    if (!code || !fromIso || !toIso) continue;

    const fromDate = extractIsoDate(fromIso);
    const fromTime = extractIsoTime(fromIso);
    const toDate = extractIsoDate(toIso);
    const toTime = extractIsoTime(toIso);

    let coveredDates = [];
    try {
      const detail = att.AttendanceData ? JSON.parse(att.AttendanceData) : [];
      coveredDates = detail
        .filter((d) => parseFloat(d.NumberOfDay) > 0)
        .map((d) => extractIsoDate(d.Date));
    } catch {
      /* fall through to plain date enumeration */
    }
    if (coveredDates.length === 0) coveredDates = enumerateDates(fromDate, toDate);

    for (const dateStr of coveredDates) {
      let start, end;
      if (fromDate === toDate) {
        start = fromTime;
        end = toTime;
      } else if (dateStr === fromDate) {
        start = fromTime;
        end = "23:59";
      } else if (dateStr === toDate) {
        start = "00:00";
        end = toTime;
      } else {
        start = "00:00";
        end = "23:59";
      }
      map[`${code}|${dateStr}`] = { start, end };
    }
  }
  return map;
}

/**
 * Leave-vs-roster gap detection.
 *
 * MISA deducts leave against a standard company calendar, but each employee has
 * their own roster. When someone takes continuous leave across a day the company
 * calendar treats as non-working — yet their roster has them scheduled — MISA
 * charges nothing and attaches no leave window to that day. The person is away,
 * but the data reads as an available, rostered driver.
 *
 * Example (DC100975, Aug 2026): leave ran Sat 8th 08:00 → Mon 10th 17:00, but
 * only the 8th and 10th were deducted. Sunday the 9th was an extra working
 * Sunday on his roster and slipped through unflagged.
 *
 * A gap day is a date that:
 *   1. falls inside a leave request's from→to span,
 *   2. was NOT charged by MISA (absent from AttendanceData, or listed as 0 days),
 *   3. is a *working* day on that employee's own roster.
 *
 * Only requests that carry an AttendanceData breakdown are checked — without it
 * every span day is treated as covered, so no gap is inferrable.
 */
export function findLeaveGaps(attendanceRows, records) {
  const roster = new Map();
  for (const r of records) roster.set(`${r.employee_code}|${r.shift_date}`, r);

  const gaps = [];
  const seen = new Set();

  for (const att of attendanceRows) {
    const code = att.EmployeeCode;
    const fromIso = att.FromDate || "";
    const toIso = att.ToDate || "";
    if (!code || !fromIso || !toIso) continue;

    let charged;
    try {
      const detail = att.AttendanceData ? JSON.parse(att.AttendanceData) : null;
      if (!detail || detail.length === 0) continue; // no breakdown → nothing to compare
      charged = new Set(
        detail.filter((d) => parseFloat(d.NumberOfDay) > 0).map((d) => extractIsoDate(d.Date)),
      );
    } catch {
      continue;
    }

    const fromDate = extractIsoDate(fromIso);
    const toDate = extractIsoDate(toIso);
    if (fromDate === toDate) continue; // single-day leave cannot straddle anything

    for (const date of enumerateDates(fromDate, toDate)) {
      if (charged.has(date)) continue;
      const shift = roster.get(`${code}|${date}`);
      if (!shift || shift.day_type !== "working") continue; // outside month, or genuinely off

      const key = `${code}|${date}`;
      if (seen.has(key)) continue;
      seen.add(key);

      gaps.push({
        employee_code: code,
        full_name: att.FullName || shift.full_name,
        date,
        rostered: `${shift.start_time || ""}-${shift.end_time || ""}`,
        leave_type: att.AttendanceTypeName || "",
        leave_from: fromIso,
        leave_to: toIso,
        reason: (att.Reason || "").trim().replace(/\s+/g, " "),
        approver: att.ApprovalName || "",
        org_unit: att.OrganizationUnitName || "",
      });
    }
  }

  gaps.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.employee_code < b.employee_code ? -1 : 1));
  return gaps;
}

/**
 * Shift page data + leave map → both output shapes:
 *  - records:   normalized rows for the driver_shifts Supabase table
 *  - sheetRows: 8-column arrays for the "Driver Shift" sheet. Columns 1-7 are the
 *    original layout (start_time holds "OFF" / holiday name on non-working days);
 *    column 8 is the leave_gap flag described in findLeaveGaps.
 *
 * Rows are derived from records after sorting, so both outputs stay aligned.
 */
export function parseShifts(pageData, leaveMap = {}, attendanceRows = []) {
  const records = [];

  for (const emp of pageData) {
    const code = emp.EmployeeCode || "";
    const name = emp.FullName || "";

    for (const key of Object.keys(emp)) {
      if (!/^\d{4}_\d{1,2}_\d{1,2}$/.test(key)) continue;
      const day = emp[key];
      const date = formatDateKey(key);
      const holiday = day.Holiday;
      const shifts = day.WorkingShifts || [];

      const leave = leaveMap[`${code}|${date}`] || {};
      const leaveStart = leave.start || "";
      const leaveEnd = leave.end || "";

      const push = (slot, dayType, startTime, endTime, holidayName) =>
        records.push({
          employee_code: code,
          full_name: name,
          shift_date: date,
          slot,
          day_type: dayType,
          start_time: dayType === "working" ? startTime || null : null,
          end_time: dayType === "working" ? endTime || null : null,
          holiday_name: dayType === "holiday" ? holidayName || null : null,
          leave_start: leaveStart || null,
          leave_end: leaveEnd || null,
          leave_gap: false, // set below by findLeaveGaps
        });

      if (holiday) {
        push(1, "holiday", "", "", holiday.HolidayTypeName);
      } else if (shifts.length === 0) {
        push(1, "off", "", "");
      } else {
        shifts.forEach((s, i) => push(i + 1, "working", s.StartTime || "", s.EndTime || ""));
      }
    }
  }

  records.sort((a, b) =>
    a.employee_code < b.employee_code
      ? -1
      : a.employee_code > b.employee_code
        ? 1
        : a.shift_date < b.shift_date
          ? -1
          : a.shift_date > b.shift_date
            ? 1
            : a.slot - b.slot,
  );

  const gaps = findLeaveGaps(attendanceRows, records);
  const gapKeys = new Set(gaps.map((g) => `${g.employee_code}|${g.date}`));
  for (const r of records) {
    if (gapKeys.has(`${r.employee_code}|${r.shift_date}`)) r.leave_gap = true;
  }

  const sheetRows = records.map((r) => [
    r.employee_code,
    r.full_name,
    r.shift_date,
    r.day_type === "holiday" ? r.holiday_name || "" : r.day_type === "off" ? "OFF" : r.start_time || "",
    r.day_type === "working" ? r.end_time || "" : "",
    r.leave_start || "",
    r.leave_end || "",
    r.leave_gap ? "1" : "",
  ]);

  return { sheetRows, records, gaps };
}
