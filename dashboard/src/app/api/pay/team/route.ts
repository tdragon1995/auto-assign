/**
 * Every part-time driver's earnings for one month — the supervisor view behind
 * the 25th payroll run, and the sibling of /api/tat/team.
 *
 * SCOPE, AND WHAT IT IS NOT. /api/pay/me answers "what did I earn" for one
 * authenticated driver. This answers "what does the fleet owe" and is therefore
 * a different kind of data: one person's payslip versus a comparison across
 * staff. It carries NO driver session — it follows the dashboard's existing
 * posture, which has no auth of any kind. That is a deliberate inheritance, not
 * an oversight; if the dashboard ever gets a gate, this route must end up behind
 * it, and it should be near the front of the queue when that happens, because
 * this is the one endpoint that returns everybody's pay.
 *
 * Defaults to the current payroll month: previous month’s 15th through this
 * month’s 14th, inclusive.
 *
 * PART-TIME ONLY. Full-time drivers appear in pay_jobs and pay_punches like
 * everyone else — the archive does not filter, and should not, because the rows
 * are a record of what happened rather than of who is owed. The filter belongs
 * here, where the rates are applied: employmentOf reads the staff code on the
 * driver's own record name (PT… / DC…), the one part of a label that survives a
 * rename.
 */
import { NextRequest, NextResponse } from "next/server";
import { sbSelectAll, supabaseConfigured } from "@/lib/supabase-rest";
import { getPayrollCoverage, missingPayrollCoverage } from "@/lib/payroll-coverage";
import { employmentOf } from "@/lib/driver-label";
import {
  workedMinutes, hourPayFor, kmPayFor,
  RATE_PER_HOUR_VND, RATE_PER_KM_VND, type PayPunch,
} from "@/lib/pay";
import { payrollPeriod } from "@/lib/pay-period";
import { vnDate } from "@/lib/time";

export const runtime = "nodejs";
export const maxDuration = 30;
export const preferredRegion = "sin1";

interface DailyRow {
  driver_id: string;
  driver_name: string | null;
  trip_date: string;
  jobs_total: number;
  jobs_priced: number;
  total_km: number | string | null;
}

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function GET(req: NextRequest) {
  if (!supabaseConfigured()) {
    return NextResponse.json({ ok: false, error: "Chưa cấu hình hệ thống lưu trữ." }, { status: 503 });
  }

  const today = vnDate();
  const month = req.nextUrl.searchParams.get("month") ?? today.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return NextResponse.json({ ok: false, error: "month phải có dạng YYYY-MM" }, { status: 400 });
  }
  const { from, to } = payrollPeriod(month);

  try {
    const [daily, punches, storedCoverage] = await Promise.all([
      sbSelectAll<DailyRow>(
        "v_pay_daily",
        `select=*&trip_date=gte.${from}&trip_date=lte.${to}&order=trip_date.asc,driver_id.asc`,
      ),
      sbSelectAll<PayPunch>(
        "pay_punches",
        `select=*&trip_date=gte.${from}&trip_date=lte.${to}&order=trip_date.asc,driver_id.asc,job_id.asc`,
      ),
      getPayrollCoverage(month),
    ]);
    const coverage = storedCoverage ?? missingPayrollCoverage(month, from, to);

    interface Acc {
      name: string | null;
      km: number;
      unpriced: number;
      jobs: number;
      /** Punches bucketed BY DAY, because the pairing is a within-day rule: a
       *  month's taps thrown into one list would pair a Monday check-in with a
       *  Tuesday check-out and bill the night in between. */
      byDay: Map<string, PayPunch[]>;
      /** Days with any activity at all — a day worked with no dispatch counts. */
      days: Set<string>;
    }
    const acc = new Map<string, Acc>();
    const get = (id: string, name: string | null): Acc => {
      const e = acc.get(id) ?? { name, km: 0, jobs: 0, unpriced: 0, byDay: new Map(), days: new Set() };
      if (!e.name && name) e.name = name;
      acc.set(id, e);
      return e;
    };

    for (const d of daily) {
      const e = get(d.driver_id, d.driver_name);
      e.km += num(d.total_km);
      e.jobs += d.jobs_total;
      e.unpriced += Math.max(0, d.jobs_total - d.jobs_priced);
      e.days.add(d.trip_date);
    }
    for (const p of punches) {
      const e = get(p.driver_id, p.driver_name);
      const list = e.byDay.get(p.trip_date);
      if (list) list.push(p); else e.byDay.set(p.trip_date, [p]);
      e.days.add(p.trip_date);
    }

    const drivers = [...acc.entries()]
      // Full-time accounts are recorded but not priced — see PART-TIME ONLY above.
      .filter(([, e]) => employmentOf(e.name) === "part-time")
      .map(([driver_id, e]) => {
        let mins = 0;
        let openInDays = 0;
        for (const dayPunches of e.byDay.values()) {
          const w = workedMinutes(dayPunches);
          mins += w.minutes;
          if (w.open_in.length > 0) openInDays++;
        }
        const km = Math.round(e.km * 100) / 100;
        return {
          driver_id,
          // The FULL record name, staff code and all — trimmed once on the way to
          // the screen, so the CSV keeps the code that payroll is keyed on and the
          // two rows a person with both a PT and a DC account produces stay
          // distinguishable.
          driver_name: e.name || driver_id.slice(0, 8),
          days_worked: e.days.size,
          jobs: e.jobs,
          unpriced_jobs: e.unpriced,
          km,
          worked_mins: mins,
          hour_pay: hourPayFor(mins),
          km_pay: kmPayFor(km),
          total_pay: hourPayFor(mins) + kmPayFor(km),
          /** Days with a check-in and no check-out. These pay nothing, so this is
           *  the column a supervisor acts on BEFORE the 25th, not after. */
          open_in_days: openInDays,
        };
      });

    // Ranked by what is owed, largest first: this is a payables list, and the
    // biggest number is the one worth checking before it is paid.
    drivers.sort((a, b) => b.total_pay - a.total_pay);

    return NextResponse.json({
      ok: true,
      month, from, to,
      rates: { per_hour: RATE_PER_HOUR_VND, per_km: RATE_PER_KM_VND },
      coverage,
      driver_count: drivers.length,
      totals: {
        days_worked: drivers.reduce((s, d) => s + d.days_worked, 0),
        jobs: drivers.reduce((s, d) => s + d.jobs, 0),
        unpriced_jobs: drivers.reduce((s, d) => s + d.unpriced_jobs, 0),
        km: Math.round(drivers.reduce((s, d) => s + d.km, 0) * 100) / 100,
        worked_mins: drivers.reduce((s, d) => s + d.worked_mins, 0),
        hour_pay: drivers.reduce((s, d) => s + d.hour_pay, 0),
        km_pay: drivers.reduce((s, d) => s + d.km_pay, 0),
        total_pay: drivers.reduce((s, d) => s + d.total_pay, 0),
        open_in_days: drivers.reduce((s, d) => s + d.open_in_days, 0),
      },
      drivers,
    });
  } catch (e) {
    console.error("[pay/team] error:", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, error: "Không tải được bảng lương tháng." }, { status: 502 });
  }
}
