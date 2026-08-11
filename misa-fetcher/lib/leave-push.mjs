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
 */

const DEFAULT_BASE = "https://diag-logistics.vercel.app";

function log(msg) {
  console.log(`[leave] ${msg}`);
}

/**
 * MISA attendance rows → one submission per charged leave day.
 *
 * MISA charges leave per day in AttendanceData (1.0 = full day, 0.5 = half).
 * Emitting one submission per charged day — rather than one spanning row —
 * keeps the sheet in step with what MISA actually deducted, which is what makes
 * the leave/roster gaps visible instead of papering over them.
 */
export function buildLeaveSubmissions(attendanceRows, driversByCode, range) {
  const subs = [];
  const unmatched = new Map();

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
      if (!date || date < range.monthStart || date > range.monthEnd) continue;

      const halfDay = num < 1;
      subs.push({
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
      });
    }
  }

  subs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.driver_name < b.driver_name ? -1 : 1));
  return { submissions: subs, unmatched };
}

/**
 * Send the submissions. A 409 means the leave is already on the sheet — that is
 * the expected steady state on re-runs, not an error.
 *
 * `dryRun` reports exactly what would be written without touching the sheet.
 */
export async function pushLeave(submissions, { dryRun = false, baseUrl } = {}) {
  const base = (baseUrl || process.env.DASHBOARD_URL || DEFAULT_BASE).replace(/\/$/, "");
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const result = { written: 0, duplicate: 0, failed: 0, errors: [] };

  if (dryRun) {
    log(`DRY RUN — ${submissions.length} leave day(s) would be submitted to ${base}/api/nghi-phep:`);
    for (const s of submissions) {
      const win = s.gio_bat_dau ? ` ${s.gio_bat_dau}-${s.gio_ket_thuc}` : "";
      log(`  ${s.date}  ${s.driver_name}  ${s.loai_nghi}${win}`);
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
          note: `MISA auto ${stamp}`,
          // No notify_message: the leave is already approved in MISA, so the
          // admin Zalo group must not be pinged again for every synced day.
        }),
      });

      if (res.status === 409) {
        result.duplicate++;
        continue;
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
