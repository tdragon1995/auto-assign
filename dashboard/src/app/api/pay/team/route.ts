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
 * DEFAULTS TO LAST MONTH, exactly as the TAT monitor does, and for the same
 * reason: payroll runs on the 25th against the month before, so the current month
 * is a half-finished number nobody is paid against.
 *
 * PART-TIME ONLY. Full-time drivers appear in pay_jobs and pay_punches like
 * everyone else — the archive does not filter, and should not, because the rows
 * are a record of what happened rather than of who is owed. The filter belongs
 * here, where the rates are applied: employmentOf reads the staff code on the
 * driver's own record name (PT… / DC…), the one part of a label that survives a
 * rename.
 */
import { NextRequest, NextResponse } from "next/server";
import { sbSelect, supabaseConfigured } from "@/lib/supabase-rest";
import { employmentOf } from "@/lib/driver-label";
import {
  workedMinutes, hourPayFor, kmPayFor,
  RATE_PER_HOUR_VND, RATE_PER_KM_VND, type PayPunch,
} from "@/lib/pay";
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

/** PostgREST caps a response at 1,000 rows by default and says so only by
 *  returning exactly that many — a silent truncation that would drop whole
 *  drivers off the end of a month, which on THIS endpoint means somebody not
 *  getting paid. Page until a short page arrives. */
async function selectAllPages<T>(table: string, query: string): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await sbSelect<T>(table, `${query}&limit=${PAGE}&offset=${offset}`);
    out.push(...page);
    if (page.length < PAGE) return out;
    if (offset > 200_000) return out;
  }
}

function monthRange(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return { from, to: d.toISOString().slice(0, 10) };
}

/** The month before the one containing `date` — the payroll default. */
function prevMonthOf(date: string): string {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

export async function GET(req: NextRequest) {
  if (!supabaseConfigured()) {
    return NextResponse.json({ ok: false, error: "Chưa cấu hình hệ thống lưu trữ." }, { status: 503 });
  }

  const today = vnDate();
  const month = req.nextUrl.searchParams.get("month") ?? prevMonthOf(today);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ ok: false, error: "month phải có dạng YYYY-MM" }, { status: 400 });
  }
  const { from, to } = monthRange(month);

  try {
    const [daily, punches] = await Promise.all([
      selectAllPages<DailyRow>(
        "v_pay_daily",
        `select=*&trip_date=gte.${from}&trip_date=lte.${to}&order=trip_date.asc`,
      ),
      selectAllPages<PayPunch>(
        "pay_punches",
        `select=*&trip_date=gte.${from}&trip_date=lte.${to}`,
      ),
    ]);

    interface Acc {
      name: string | null;
      km: number;
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
      const e = acc.get(id) ?? { name, km: 0, jobs: 0, byDay: new Map(), days: new Set() };
      if (!e.name && name) e.name = name;
      acc.set(id, e);
      return e;
    };

    for (const d of daily) {
      const e = get(d.driver_id, d.driver_name);
      e.km += num(d.total_km);
      e.jobs += d.jobs_total;
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
      driver_count: drivers.length,
      totals: {
        days_worked: drivers.reduce((s, d) => s + d.days_worked, 0),
        jobs: drivers.reduce((s, d) => s + d.jobs, 0),
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
