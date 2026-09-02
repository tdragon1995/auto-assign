/**
 * Push approved MISA leave into the live Nghỉ phép tab — the sheet the assign
 * engine actually reads.
 *
 * It POSTs to the dashboard's existing /api/nghi-phep rather than writing the
 * sheet directly, which buys three things already proven in production:
 *   - findLeaveConflict dedupe: a re-run of the same month returns 409 for leave
 *     that is already recorded, so the push is idempotent by construction;
 *   - a formula-safe append (the sheet's driver_id/day/sub#_id columns are
 *     formulas that a naive append would wipe);
 *   - one definition of what a leave row means, shared with the driver form.
 *
 * Substitute columns are deliberately left blank — MISA has no notion of who
 * covers a shift, and that stays the supervisor's call.
 *
 * One thing it adds that MISA cannot know: the PART-TIME TWIN. See
 * buildPtCompanion.
 */

const DEFAULT_BASE = "https://diag-logistics.vercel.app";

function log(msg) {
  console.log(`[leave] ${msg}`);
}

/** Today in VN. The entrypoint pins process.env.TZ, so the local getters are VN. */
function todayVn() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The hour a driver stops being their full-time self.
 *
 * Roughly a dozen people hold TWO Cartrack accounts under one personal name: a
 * full-time `DC…` record and a part-time `PT…` one. The full-time account works
 * the rostered shift; the part-time account is what picks up a trip running past
 * it. MISA only knows the employment the person is paid leave against — the
 * full-time one — so leave arrives naming that account alone, and the twin stays
 * "available" all evening. This threshold is where that matters: leave covering
 * any part of the day after noon takes the evening with it.
 */
export const PT_SWITCH_MIN = 12 * 60; // 12:00

/** The end of the PT companion window. Half-open at the start, inclusive at the
 *  end (see inWindow in leave-config.ts), so 23:59 is the last minute of the day
 *  and the engine reads it as "off for the rest of it". */
const DAY_END = "23:59";

/** "06:30" → 390; -1 for anything unparseable. Mirrors timeToMins in
 *  dashboard/src/lib/time.ts — this package cannot import the TypeScript one. */
function timeToMins(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((t || "").trim());
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * A driver label reduced to the personal name two people typing it would agree
 * on: no employment/area prefix, no staff code, no accents, no case.
 *
 * Deliberately the same reduction as normalizeDriverName in
 * dashboard/src/lib/driver-match.ts, including the separate `đ` line — Unicode
 * decomposition leaves that letter untouched, so without it "Đoàn" and "Doan"
 * would never meet. Kept as a copy rather than shared because this package is
 * plain .mjs run from a GitHub Action and the dashboard's is TypeScript; if the
 * two ever disagree, THAT one is the definition.
 */
export function personName(label) {
  if (!label) return "";
  const stripped = label.replace(/^.*?\b(?:PT|DC)[A-Z0-9]*\s+/, "").trim() || label.trim();
  return stripped
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** The staff code out of a label: "F - C - DC100320 Lý Chánh Hùng" → "DC100320".
 *  Upper-case only on purpose — a lower-case "dc" inside a Vietnamese name is
 *  not a code. */
function labelCode(label) {
  const m = label ? /\b(?:PT|DC)[A-Z0-9]*/.exec(label) : null;
  return m ? m[0] : "";
}

/** A part-time account. The staff code decides it where there is one; the label
 *  prefix ("P - P - …") is the fallback for a record that never got a code. */
export function isPartTime(label) {
  const code = labelCode(label);
  if (code) return code.startsWith("PT");
  return /^P\s*-/.test((label || "").trim());
}

/**
 * The one part-time account belonging to the same person as `driver`, or null.
 *
 * Timid on purpose, the same way driver-match.ts is: exactly one active
 * part-time account with the same personal name, or nothing. Two candidates
 * means the name genuinely does not say which record is meant, and inventing a
 * day off on the wrong account takes a working driver off the road — a strictly
 * worse outcome than the gap this feature closes.
 *
 * `reason` names why nothing came back, so the run can report it instead of
 * silently doing half the job.
 */
export function findPtTwin(driver, roster) {
  if (!driver || isPartTime(driver.label)) return { twin: null, reason: "already-pt" };
  const want = personName(driver.label);
  if (!want) return { twin: null, reason: "no-name" };
  const hits = roster.filter(
    (r) =>
      r.active &&
      r.driver_id &&
      r.driver_id !== driver.driver_id &&
      isPartTime(r.label) &&
      personName(r.label) === want,
  );
  if (hits.length === 1) return { twin: hits[0], reason: "ok" };
  return { twin: null, reason: hits.length ? "ambiguous" : "none" };
}

/**
 * The leave row to file against the part-time twin, or null when the day off
 * does not reach the twin at all.
 *
 *   - A full day off is a full day off on both accounts.
 *   - A half day is only the twin's problem when it runs past noon: someone off
 *     from 13:00 is not coming back for an evening trip either, so the twin is
 *     off from the moment the person leaves until the end of the day. The window
 *     deliberately does NOT mirror the MISA one — a 12:00–18:00 leave mirrored
 *     onto the twin would leave the 18:00–22:00 stretch, which is exactly when
 *     the twin account is used, still reading as available.
 *   - A MORNING half day is left alone: the person is back for their own shift,
 *     so the evening is unaffected.
 *   - A half day with no usable window is left alone too — the engine already
 *     ignores such a row (coverageOnDate refuses to render one), so guessing a
 *     window here would make the twin MORE off than the person it copies.
 */
export function buildPtCompanion(sub, twin) {
  const base = {
    ...sub,
    driver_id: twin.driver_id,
    driver_name: twin.label,
    employee_code: twin.employee_code || sub.employee_code,
    // Marks the row in the sheet's note column, so a supervisor reading the tab
    // can tell a derived row from one MISA actually charged.
    pt_companion: true,
    companion_of: sub.driver_name,
  };

  if (sub.loai_nghi !== "nua_buoi") {
    return { ...base, gio_bat_dau: null, gio_ket_thuc: null };
  }

  const start = timeToMins(sub.gio_bat_dau);
  const end = timeToMins(sub.gio_ket_thuc);
  if (start < 0 || end <= start) return null; // no usable window — see above
  if (end <= PT_SWITCH_MIN) return null;      // morning only

  return { ...base, gio_bat_dau: sub.gio_bat_dau, gio_ket_thuc: DAY_END };
}

/**
 * MISA attendance rows → one submission per charged leave day.
 *
 * MISA charges leave per day in AttendanceData (1.0 = full day, 0.5 = half).
 * Emitting one submission per charged day — rather than one spanning row —
 * keeps the sheet in step with what MISA actually deducted, which is what makes
 * the leave/roster gaps visible instead of papering over them.
 *
 * `roster` is the full Driver tab. Given one, every charged day also produces a
 * row for the person's part-time twin where they have one and the day off
 * reaches it — see buildPtCompanion. Omit it and the behaviour is exactly what
 * it was before: full-time rows only.
 */
export function buildLeaveSubmissions(
  attendanceRows,
  driversByCode,
  range,
  { minDate = todayVn(), roster = [] } = {},
) {
  const subs = [];
  const unmatched = new Map();
  // Codes whose twin could not be resolved to exactly one account. Reported so a
  // half-done sync is visible; an ambiguous name is left alone, never guessed.
  const ptUnresolved = new Map();
  // Resolved once per person rather than once per charged day.
  const twinCache = new Map();
  const twinFor = (driver) => {
    if (!twinCache.has(driver.driver_id)) {
      twinCache.set(driver.driver_id, roster.length ? findPtTwin(driver, roster) : { twin: null, reason: "no-roster" });
    }
    return twinCache.get(driver.driver_id);
  };
  // The sheet spans past months so the roster stays reviewable, but leave that
  // has already happened cannot be acted on — writing it would only add noise
  // to a tab the assign engine reads every cycle.
  const floor = minDate > range.monthStart ? minDate : range.monthStart;

  for (const att of attendanceRows) {
    const code = (att.EmployeeCode || "").trim();
    if (!code) continue;

    const driver = driversByCode.get(code);
    if (!driver) {
      if (!unmatched.has(code)) unmatched.set(code, att.FullName || "");
      continue;
    }

    let detail = [];
    try {
      detail = att.AttendanceData ? JSON.parse(att.AttendanceData) : [];
    } catch {
      detail = [];
    }

    const fromTime = (att.FromDate || "").slice(11, 16);
    const toTime = (att.ToDate || "").slice(11, 16);

    for (const d of detail) {
      const num = parseFloat(d.NumberOfDay);
      if (!(num > 0)) continue;
      const date = (d.Date || "").slice(0, 10);
      if (!date || date < floor || date > range.monthEnd) continue;

      const halfDay = num < 1;
      const sub = {
        driver_id: driver.driver_id,
        driver_name: driver.label,
        employee_code: code,
        date,
        loai_nghi: halfDay ? "nua_buoi" : "nguyen_buoi",
        ngay_bat_dau: date,
        ngay_ket_thuc: date,
        gio_bat_dau: halfDay ? fromTime || null : null,
        gio_ket_thuc: halfDay ? toTime || null : null,
        leave_type: att.AttendanceTypeName || "",
      };
      subs.push(sub);

      // The same day off, against the part-time account the person switches to
      // for a trip running past their full-time shift. MISA only ever names the
      // account it charges the leave to, so without this the twin reads as
      // available on a day its owner is not there at all.
      const { twin, reason } = twinFor(driver);
      if (twin) {
        const companion = buildPtCompanion(sub, twin);
        if (companion) subs.push(companion);
      } else if (reason === "ambiguous" && !ptUnresolved.has(code)) {
        ptUnresolved.set(code, driver.label);
      }
    }
  }

  subs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.driver_name < b.driver_name ? -1 : 1));
  return { submissions: subs, unmatched, ptUnresolved };
}

/**
 * Send the submissions. A 409 means the leave is already on the sheet — that is
 * the expected steady state on re-runs, not an error. A 503 means the dashboard
 * could not read the sheet to check, which stops the batch: writing blind is
 * what put the same day off on the sheet 21 times on 30/08.
 *
 * `dryRun` reports exactly what would be written without touching the sheet.
 */
export async function pushLeave(submissions, { dryRun = false, baseUrl } = {}) {
  const base = (baseUrl || process.env.DASHBOARD_URL || DEFAULT_BASE).replace(/\/$/, "");
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const result = { written: 0, duplicate: 0, failed: 0, aborted: false, errors: [] };

  if (dryRun) {
    log(`DRY RUN — ${submissions.length} leave day(s) would be submitted to ${base}/api/nghi-phep:`);
    for (const s of submissions) {
      const win = s.gio_bat_dau ? ` ${s.gio_bat_dau}-${s.gio_ket_thuc}` : "";
      const via = s.pt_companion ? `  ← PT của ${s.companion_of}` : "";
      log(`  ${s.date}  ${s.driver_name}  ${s.loai_nghi}${win}${via}`);
    }
    return result;
  }

  for (const s of submissions) {
    try {
      const res = await fetch(`${base}/api/nghi-phep`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driver_id: s.driver_id,
          driver_name: s.driver_name,
          loai_nghi: s.loai_nghi,
          ngay_bat_dau: s.ngay_bat_dau,
          ngay_ket_thuc: s.ngay_ket_thuc,
          gio_bat_dau: s.gio_bat_dau,
          gio_ket_thuc: s.gio_ket_thuc,
          // A companion row is NOT something MISA charged — it is derived from
          // the twin's row by this pusher. Saying so in the note is what lets a
          // supervisor delete it from the dashboard without wondering whether
          // MISA will put it back.
          note: s.pt_companion ? `MISA auto PT ${stamp}` : `MISA auto ${stamp}`,
          // No notify_message: the leave is already approved in MISA, so the
          // admin Zalo group must not be pinged again for every synced day.
        }),
      });

      if (res.status === 409) {
        result.duplicate++;
        continue;
      }
      // 503 = the dashboard could not read the Nghỉ phép tab, so it refused to
      // write rather than risk a duplicate. Every remaining submission would hit
      // the same wall, so stop the batch instead of grinding through it: the
      // next run picks the day up once the sheet reads again.
      if (res.status === 503) {
        result.failed++;
        result.errors.push(
          `${s.date} ${s.driver_name}: bảng nghỉ phép chưa đọc được — dừng đợt push, ` +
            `${submissions.length - result.written - result.duplicate - result.failed} ngày còn lại bỏ qua`,
        );
        result.aborted = true;
        break;
      }
      if (!res.ok) {
        const body = await res.text();
        result.failed++;
        result.errors.push(`${s.date} ${s.driver_name}: HTTP ${res.status} ${body.slice(0, 120)}`);
        continue;
      }
      result.written++;
      log(`wrote ${s.date} ${s.driver_name} (${s.loai_nghi})`);
    } catch (e) {
      result.failed++;
      result.errors.push(`${s.date} ${s.driver_name}: ${e.message}`);
    }
    // The route re-reads the 68 KB leave sheet on every call to dedupe; don't
    // hammer it.
    await new Promise((r) => setTimeout(r, 400));
  }

  return result;
}
