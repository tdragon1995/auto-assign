/**
 * Import payroll's shifts for one payroll period — the Lương PT tab's
 * "Nhập ca từ file" button. The browser parses the xlsx (lib/pay-shifts.ts) and
 * posts the rows; this re-validates them, resolves each account to a driver, and
 * writes them INTO Lịch ca tài xế (driver_shifts, source 'payroll') through
 * import_payroll_shifts: for every driver-day in the file, that day's shifts
 * become exactly payroll's windows. Days payroll did not pay are left alone, and
 * the MISA refresh leaves 'payroll' rows alone. Re-importing a corrected file is
 * how a shift is corrected.
 *
 * Why into Lịch ca: one shift source for dispatch and pay. Lịch ca on its own
 * matched payroll's shifts on only half the days of 1–14/09 (2026-10-08).
 *
 * Same auth posture as /api/pay/team (the dashboard has none); see that route.
 */
import { NextRequest, NextResponse } from "next/server";
import { sbRpc, sbSelectAll, supabaseConfigured } from "@/lib/supabase-rest";
import { assertMasterWritable } from "@/lib/master-store";
import { validShiftRow, resolveDriver, type ShiftImportRow } from "@/lib/pay-shifts";
import { payrollPeriod } from "@/lib/pay-period";

export const runtime = "nodejs";
export const maxDuration = 30;
export const preferredRegion = "sin1";

/** A month is ~1,100 rows today; the cap is headroom, not a target. */
const MAX_ROWS = 5000;

export async function POST(req: NextRequest) {
  if (!supabaseConfigured()) {
    return NextResponse.json({ ok: false, error: "Chưa cấu hình hệ thống lưu trữ." }, { status: 503 });
  }
  const body = await req.json().catch(() => null) as { month?: unknown; rows?: unknown } | null;
  const month = typeof body?.month === "string" ? body.month : "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return NextResponse.json({ ok: false, error: "Tháng không hợp lệ." }, { status: 400 });
  }
  if (!Array.isArray(body?.rows) || body.rows.length === 0 || body.rows.length > MAX_ROWS) {
    return NextResponse.json({ ok: false, error: "File không có dòng ca nào hợp lệ." }, { status: 400 });
  }
  const { from, to } = payrollPeriod(month);

  // Trust nothing the browser parsed: every row is checked again here.
  const rows = (body.rows as Partial<ShiftImportRow>[]).filter(validShiftRow);
  const outside = rows.filter((r) => r.date < from || r.date > to);
  if (rows.length === 0 || outside.length > 0) {
    return NextResponse.json({
      ok: false,
      error: outside.length > 0
        ? `${outside.length} dòng nằm ngoài kỳ lương ${from} – ${to}. Có đúng tháng không?`
        : "File không có dòng ca nào hợp lệ.",
    }, { status: 400 });
  }

  try {
    // Every PT account the app has seen in the period, to resolve the file's
    // labels — from the per-day rollup rather than the ~17,000 job rows behind it.
    const range = `trip_date=gte.${from}&trip_date=lte.${to}&driver_name=ilike.*PT*`;
    const [a, b] = await Promise.all([
      sbSelectAll<{ driver_id: string; driver_name: string | null }>("pay_punches", `select=driver_id,driver_name&${range}`, "id.asc"),
      sbSelectAll<{ driver_id: string; driver_name: string | null }>("v_pay_daily", `select=driver_id,driver_name&${range}`, "trip_date.asc,driver_id.asc"),
    ]);
    const known = [...new Map([...a, ...b].map((k) => [`${k.driver_id}|${k.driver_name}`, k])).values()];

    assertMasterWritable();
    const byKey = new Map<string, { driver_id: string; shift_date: string; start_time: string; end_time: string }>();
    const unmatched = new Set<string>();
    for (const r of rows) {
      const driver_id = resolveDriver(r, known);
      // Lịch ca needs a driver; an account the app cannot place is reported, not stored.
      if (!driver_id) { unmatched.add(r.account); continue; }
      // One window per driver, date and start — a repeated row is the same shift.
      byKey.set(`${driver_id}|${r.date}|${r.start}`, { driver_id, shift_date: r.date, start_time: r.start, end_time: r.end });
    }
    if (byKey.size === 0) {
      return NextResponse.json({ ok: false, error: "Không khớp được tài khoản nào trong file." }, { status: 400 });
    }

    const written = await sbRpc<number>("import_payroll_shifts", { p_from: from, p_to: to, rows: [...byKey.values()] });

    return NextResponse.json({
      ok: true, month, from, to,
      imported: written,
      // Rows dated before the payroll-history cutoff are refused by Lịch ca's
      // retention rule; say so rather than reporting them as imported.
      too_old: byKey.size - written,
      drivers: new Set([...byKey.values()].map((r) => r.driver_id)).size,
      // Not stored: payroll named an account the app has no taps or trips for.
      unmatched: [...unmatched].sort(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[pay/shifts] import error:", msg);
    // assertMasterWritable's message is meant for the person; anything else is not.
    return NextResponse.json({ ok: false, error: msg.startsWith("Supabase đang") ? msg : "Không lưu được ca vào Lịch ca. Thử lại sau." }, { status: 502 });
  }
}
