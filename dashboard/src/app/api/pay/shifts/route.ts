/**
 * Import payroll's shifts for one payroll period — the Lương PT tab's
 * "Nhập ca từ file" button. The browser parses the xlsx (lib/pay-shifts.ts) and
 * posts the rows; this re-validates them, resolves each account to a driver, and
 * REPLACES the period's shifts. Re-importing a corrected file is how a shift is
 * corrected.
 *
 * Same auth posture as /api/pay/team (the dashboard has none); see that route.
 *
 * Replace = upsert with a fresh stamp, then delete the period's rows that did
 * not get it. A failure part-way leaves the previous import in place rather
 * than an empty period — the pattern the pay archive uses.
 */
import { NextRequest, NextResponse } from "next/server";
import { sbDelete, sbSelectAll, sbUpsert, supabaseConfigured } from "@/lib/supabase-rest";
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

    const stamp = new Date().toISOString();
    const byKey = new Map<string, Record<string, unknown>>();
    const unmatched = new Set<string>();
    for (const r of rows) {
      const driver_id = resolveDriver(r, known);
      if (!driver_id) unmatched.add(r.account);
      // One window per account, date and start — a repeated row is the same shift.
      byKey.set(`${r.date}|${r.account}|${r.start}`, {
        trip_date: r.date, driver_id, staff_code: r.code || null, account_name: r.account,
        shift_start: r.start, shift_end: r.end, source: "payroll-file", imported_at: stamp,
      });
    }

    await sbUpsert("pay_shifts", [...byKey.values()], "trip_date,account_name,shift_start");
    await sbDelete("pay_shifts", `trip_date=gte.${from}&trip_date=lte.${to}&imported_at=lt.${encodeURIComponent(stamp)}`);

    return NextResponse.json({
      ok: true, month, from, to,
      imported: byKey.size,
      drivers: new Set(rows.map((r) => r.account)).size,
      // Stored, but paying nothing until the account is recognised: payroll named
      // someone the app has no taps or trips for in this period.
      unmatched: [...unmatched].sort(),
    });
  } catch (e) {
    console.error("[pay/shifts] import error:", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, error: "Không lưu được ca. Thử lại sau." }, { status: 502 });
  }
}
