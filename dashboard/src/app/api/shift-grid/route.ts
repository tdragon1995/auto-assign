/**
 * GET /api/shift-grid?month=YYYY-MM — Bảng ca: one pay period (15 → 14), every
 * driver with anything that period (a shift, a tap, a trip, leave, a day off),
 * each day's plan against what happened. Shifts come from the same loader pay
 * uses (lib/pay-days: Lịch ca + Lịch Chủ nhật + leave covers), so the grid and
 * Lương PT can never disagree about who had a shift.
 */
import { NextRequest, NextResponse } from "next/server";
import { sbSelectAll, supabaseConfigured } from "@/lib/supabase-rest";
import { loadPayDayInputs, dayKey } from "@/lib/pay-days";
import { suggestedWindow, type PayPunch } from "@/lib/pay";
import { payrollPeriod } from "@/lib/pay-period";
import { shiftDrivers, shiftPatterns } from "@/lib/driver-shifts";
import { employmentOf } from "@/lib/driver-label";
import { driverDisplayName } from "@/lib/display-names";
import { cellStatus, periodMonthOf } from "@/lib/shift-grid";
import { addDays, vnDate } from "@/lib/time";

export const runtime = "nodejs";
export const preferredRegion = "sin1";
export const maxDuration = 30;

const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false });
const hhmm = (iso: string | null) => (iso ? clock.format(new Date(iso)) : null);

export async function GET(req: NextRequest) {
  if (!supabaseConfigured()) return NextResponse.json({ error: "Chưa cấu hình hệ thống lưu trữ." }, { status: 503 });
  const today = vnDate();
  const month = req.nextUrl.searchParams.get("month") ?? periodMonthOf(today);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return NextResponse.json({ error: "month phải có dạng YYYY-MM" }, { status: 400 });
  const { from, to } = payrollPeriod(month);
  try {
    const [inputs, drivers, patterns, punches, daily, offRows, leaves] = await Promise.all([
      loadPayDayInputs(from, to),
      shiftDrivers(),
      shiftPatterns(),
      sbSelectAll<PayPunch>("pay_punches", `select=*&trip_date=gte.${from}&trip_date=lte.${to}`, "id.asc"),
      sbSelectAll<{ driver_id: string; trip_date: string; first_pickup_ts: string | null; last_dropoff_ts: string | null }>(
        "v_pay_daily", `select=driver_id,trip_date,first_pickup_ts,last_dropoff_ts&trip_date=gte.${from}&trip_date=lte.${to}`, "trip_date.asc,driver_id.asc"),
      sbSelectAll<{ driver_id: string | null; shift_date: string; day_type: string; holiday_name: string | null }>(
        "driver_shifts", `select=driver_id,shift_date,day_type,holiday_name&day_type=in.(off,holiday)&shift_date=gte.${from}&shift_date=lte.${to}&driver_id=not.is.null`, "shift_date.asc"),
      sbSelectAll<{ linked_driver_id: string | null; starts_on: string; ends_on: string; starts_at: string | null }>(
        "master_leave_read", `select=linked_driver_id,starts_on,ends_on,starts_at&active=eq.true&starts_on=lte.${to}&ends_on=gte.${from}`, "id.asc"),
    ]);

    const days: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const byId = new Map(drivers.map((d) => [d.driver_id, d]));
    const name = (id: string) => driverDisplayName(byId.get(id)?.name ?? "") || id.slice(0, 8);

    const punchBy = new Map<string, PayPunch[]>();
    for (const p of punches) { const k = dayKey(p.driver_id, p.trip_date); const l = punchBy.get(k); if (l) l.push(p); else punchBy.set(k, [p]); }
    const dailyBy = new Map(daily.map((d) => [dayKey(d.driver_id, d.trip_date), d]));
    const offBy = new Map(offRows.filter((r) => r.driver_id).map((r) => [dayKey(r.driver_id!, r.shift_date), r]));
    const leaveBy = new Map<string, "whole" | "half">();
    for (const l of leaves) {
      if (!l.linked_driver_id) continue;
      for (let d = l.starts_on < from ? from : l.starts_on; d <= (l.ends_on > to ? to : l.ends_on); d = addDays(d, 1)) {
        const k = dayKey(l.linked_driver_id, d);
        if (leaveBy.get(k) !== "whole") leaveBy.set(k, l.starts_at ? "half" : "whole");
      }
    }

    // A row for anyone with anything this period.
    const ids = new Set<string>();
    for (const k of [...inputs.shifts.keys(), ...punchBy.keys(), ...dailyBy.keys(), ...offBy.keys(), ...leaveBy.keys()]) ids.add(k.split("|")[0]);
    const tapped = (ps: PayPunch[] | undefined) => (ps ?? []).some((p) => p.started_ts || p.arrived_ts || p.completed_ts);

    const rows = [...ids].filter((id) => byId.has(id)).map((id) => {
      const full = byId.get(id)?.name ?? "";
      const type = employmentOf(full) === "part-time" ? "PT" : "FT";
      // The weekly shift in force today (newest version that has started), for the row's own editor.
      const versions = patterns.filter((p) => p.driver_id === id && p.active && !p.review_issues.length && p.days.some(Boolean)
        && (!p.active_from || p.active_from <= today) && (!p.active_to || p.active_to >= today));
      const week = versions.sort((a, b) => (a.active_from ?? "").localeCompare(b.active_from ?? "")).at(-1) ?? null;
      const cells: Record<string, { p?: string; a?: string; s: string; t?: string[]; sug?: [string, string] }> = {};
      for (const date of days) {
        const k = dayKey(id, date);
        const plan = inputs.shifts.get(k) ?? [];
        const ps = punchBy.get(k);
        const t = dailyBy.get(k);
        const w = tapped(ps) || t ? suggestedWindow(ps ?? [], t?.first_pickup_ts ?? null, t?.last_dropoff_ts ?? null, date) : null;
        const actualIn = hhmm(w?.in ?? null), actualOut = hhmm(w?.out ?? null);
        const leave = leaveBy.get(k);
        const off = offBy.get(k);
        const corr = inputs.latest.get(k);
        const status = cellStatus({
          plan, actualIn, actualOut, wholeDayLeave: leave === "whole", dayOff: !!off,
          approved: inputs.approved.has(k), past: date < today,
        });
        const tags: string[] = [];
        const o = inputs.origin.get(k);
        if (o?.sunday) tags.push("CN");
        for (const c of o?.covers ?? []) tags.push(`Thay ${name(c)}`);
        if (leave === "half") tags.push("Nghỉ nửa ngày");
        if (off?.day_type === "holiday") tags.push(off.holiday_name || "Lễ");
        if (corr?.status === "pending") tags.push("Chờ duyệt");
        if (!status && !tags.length && !plan.length) continue;
        const approvedWin = inputs.approved.get(k);
        cells[date] = {
          ...(plan.length ? { p: plan.map((x) => `${x.start}–${x.end}`).join(", ") } : {}),
          ...(approvedWin ? { p: `${approvedWin.start}–${approvedWin.end}` } : {}),
          ...(actualIn ? { a: `${actualIn}–${actualOut ?? ""}` } : {}),
          s: status,
          ...(tags.length ? { t: tags } : {}),
          ...(status === "noshift" && type === "PT" && actualIn && actualOut ? { sug: [actualIn, actualOut] as [string, string] } : {}),
        };
      }
      return {
        driver_id: id, name: name(id), code: byId.get(id)?.employee_code?.startsWith("driver:") ? "" : byId.get(id)?.employee_code ?? "",
        type, active: byId.get(id)?.active !== false,
        week: week ? { from: week.active_from, days: week.days } : null,
        cells,
      };
    }).filter((r) => Object.keys(r.cells).length)
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "vi") : a.type === "PT" ? -1 : 1));

    return NextResponse.json({ month, from, to, today, days, rows });
  } catch (e) {
    console.error("[shift-grid]", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Không tải được bảng ca." }, { status: 502 });
  }
}
