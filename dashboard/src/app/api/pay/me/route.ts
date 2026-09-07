/**
 * A part-time driver's own monthly earnings.
 *
 * AUTHORIZATION — the driver_id comes from the signed HttpOnly nv_session cookie
 * and NEVER from a query parameter or body. Same rule as /api/tat/me and
 * /api/driver-jobs, and here it is the strictest case of all: a readable id in
 * the request would make every driver's pay readable by every other driver.
 *
 * PART-TIME ONLY. The rates are the part-time contract; a full-time account's
 * figure would be a wrong payslip, and a wrong payslip gets believed. The gate
 * reads the staff code on the authenticated name (employmentOf: DC… full-time,
 * PT… part-time) and answers 403 for anything that is not PT, INCLUDING an
 * account whose label carries no code at all — this is money, so "cannot tell"
 * has to mean no.
 *
 * TWO MODES
 *   ?month=YYYY-MM → the month: totals, plus one line per worked day.
 *   ?date=YYYY-MM-DD → one day: the jobs and the taps underneath a day's line.
 *
 * FRESHNESS — this reads only SEALED days, the ones the morning archive pass has
 * already written, and it never triggers an archive of its own. Deliberately: the
 * TAT report used to refresh today on demand and it became the single most
 * expensive thing in the system (see /api/tat/me). Today's earnings are not shown
 * for the same reason they are not shown there, plus a better one — a part-day
 * total that changes every time you look is not something anyone should be
 * checking their pay against.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifySession, NV_COOKIE } from "@/lib/driver-session";
import { sbSelect, supabaseConfigured } from "@/lib/supabase-rest";
import { employmentOf } from "@/lib/driver-label";
import {
  workedMinutes, hourPayFor, kmPayFor, punchAt,
  RATE_PER_HOUR_VND, RATE_PER_KM_VND,
  type PayPunch, type PayJob,
} from "@/lib/pay";
import { vnDate, addDays } from "@/lib/time";

export const runtime = "nodejs";
export const maxDuration = 30;
export const preferredRegion = "sin1";

/** The report stops at yesterday — see FRESHNESS above. */
const latestDayFor = (today: string) => addDays(today, -1);

interface DailyRow {
  driver_id: string;
  trip_date: string;
  driver_name: string | null;
  jobs_total: number;
  jobs_priced: number;
  total_km: number | string | null;
}

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false,
});
const hhmm = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : timeFmt.format(d);
};

/** PostgREST returns numerics as strings. Parse once, here, so no caller has to
 *  wonder whether the km it is holding is a number. */
const num = (v: number | string | null | undefined): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const monthStart = (m: string) => `${m}-01`;
function monthEnd(m: string): string {
  const d = new Date(`${m}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
const monthOf = (date: string) => date.slice(0, 7);
function addMonths(m: string, n: number): string {
  const d = new Date(`${m}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}

/** One day's line on the month view. The hours are derived HERE, from the stored
 *  taps, rather than read from a column — that is what makes the payroll formula
 *  replaceable without re-archiving anything. See pay.ts/workedMinutes. */
function dayLine(date: string, km: number, jobs: number, punches: PayPunch[]) {
  const worked = workedMinutes(punches);
  return {
    date,
    jobs,
    km: Math.round(km * 100) / 100,
    worked_mins: worked.minutes,
    spans: worked.spans.map((s) => ({ from: hhmm(s.from), to: hhmm(s.to), minutes: s.minutes })),
    // Surfaced, not swallowed: an unclosed shift pays nothing, and the driver
    // needs to see WHICH day so they can get it fixed before payday.
    open_in: worked.open_in.map(hhmm).filter((t): t is string => t !== null),
    stray_out: worked.stray_out.map(hhmm).filter((t): t is string => t !== null),
    hour_pay: hourPayFor(worked.minutes),
    km_pay: kmPayFor(km),
    total_pay: hourPayFor(worked.minutes) + kmPayFor(km),
  };
}

export async function GET(req: NextRequest) {
  const session = verifySession(req.cookies.get(NV_COOKIE)?.value);
  if (!session) {
    return NextResponse.json(
      { ok: false, expired: true, error: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại." },
      { status: 401 },
    );
  }

  if (employmentOf(session.driver_name) !== "part-time") {
    return NextResponse.json(
      {
        ok: false,
        not_part_time: true,
        error: "Bảng thu nhập chỉ áp dụng cho tài khoản bán thời gian (PT).",
      },
      { status: 403 },
    );
  }

  if (!supabaseConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Bảng thu nhập chưa sẵn sàng — hệ thống lưu trữ chưa được cấu hình." },
      { status: 503 },
    );
  }

  const sp = req.nextUrl.searchParams;
  const driverId = session.driver_id;
  const latest = latestDayFor(vnDate());

  const rates = {
    per_hour: RATE_PER_HOUR_VND,
    per_km: RATE_PER_KM_VND,
    // Stated so the screen can say what it is paying for rather than only what it
    // paid, and so a disputed figure can be checked without reading this file.
    km_basis: "Quãng đường lấy mẫu → giao mẫu của mỗi chuyến đã hoàn thành",
  };

  // ── Day-detail mode ───────────────────────────────────────────────────────
  const askedDate = sp.get("date");
  if (askedDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(askedDate) || askedDate > latest) {
      return NextResponse.json({ ok: false, error: "Ngày không hợp lệ." }, { status: 400 });
    }
    try {
      const [jobs, punches] = await Promise.all([
        sbSelect<PayJob>(
          "pay_jobs",
          `select=*&driver_id=eq.${driverId}&trip_date=eq.${askedDate}&order=dropoff_completed_ts.asc`,
        ),
        sbSelect<PayPunch>(
          "pay_punches",
          `select=*&driver_id=eq.${driverId}&trip_date=eq.${askedDate}`,
        ),
      ]);

      const km = jobs.reduce((sum, j) => sum + num(j.distance_km), 0);
      return NextResponse.json({
        ok: true,
        date: askedDate,
        rates,
        day: dayLine(askedDate, km, jobs.length, punches),
        jobs: jobs.map((j) => ({
          job_id: j.job_id,
          reference_number: j.reference_number,
          pickup: j.pickup_name,
          dropoff: j.dropoff_name,
          picked_at: hhmm(j.pickup_completed_ts),
          dropped_at: hhmm(j.dropoff_completed_ts),
          km: j.distance_km == null ? null : num(j.distance_km),
          // Display only. The day and month totals price the SUMMED kilometres
          // once (see kmPayFor) — adding these thirty roundings would drift from
          // the total the driver is shown, and a payslip whose lines do not add
          // up to its own total is a payslip nobody trusts.
          pay: j.distance_km == null ? null : kmPayFor(num(j.distance_km)),
        })),
        punches: punches
          .map((p) => ({ kind: p.kind, at: hhmm(punchAt(p)), location: p.location_name }))
          .filter((p) => p.at !== null)
          .sort((a, b) => (a.at! < b.at! ? -1 : 1)),
      });
    } catch (e) {
      console.error("[pay/me] day error:", e instanceof Error ? e.message : e);
      return NextResponse.json({ ok: false, error: "Không tải được dữ liệu ngày này." }, { status: 200 });
    }
  }

  // ── Month mode ────────────────────────────────────────────────────────────
  const askedMonth = sp.get("month") ?? monthOf(latest);
  if (!/^\d{4}-\d{2}$/.test(askedMonth)) {
    return NextResponse.json({ ok: false, error: "Tháng không hợp lệ." }, { status: 400 });
  }
  const from = monthStart(askedMonth);
  // A month still running ends at the last sealed day, not at its own last date.
  const to = monthEnd(askedMonth) > latest ? latest : monthEnd(askedMonth);

  try {
    if (to < from) {
      // A month that has not started yet — the "next month" arrow can reach it.
      return NextResponse.json({
        ok: true, driver_name: session.driver_name, month: askedMonth, from, to: from,
        rates, latest, days: [],
        summary: { days: 0, jobs: 0, km: 0, worked_mins: 0, hour_pay: 0, km_pay: 0, total_pay: 0, open_in_days: 0 },
      });
    }

    const [daily, punches] = await Promise.all([
      sbSelect<DailyRow>(
        "v_pay_daily",
        `select=*&driver_id=eq.${driverId}&trip_date=gte.${from}&trip_date=lte.${to}&order=trip_date.asc`,
      ),
      sbSelect<PayPunch>(
        "pay_punches",
        `select=*&driver_id=eq.${driverId}&trip_date=gte.${from}&trip_date=lte.${to}`,
      ),
    ]);

    const punchesByDay = new Map<string, PayPunch[]>();
    for (const p of punches) {
      const list = punchesByDay.get(p.trip_date);
      if (list) list.push(p); else punchesByDay.set(p.trip_date, [p]);
    }

    // A day a driver clocked in but was dispatched nothing has punches and no
    // job row, so the union of both sources is what makes a day exist — reading
    // only the job rollup would stop paying for exactly those days.
    const dates = [...new Set([...daily.map((d) => d.trip_date), ...punchesByDay.keys()])].sort();
    const kmByDay = new Map(daily.map((d) => [d.trip_date, num(d.total_km)]));
    const jobsByDay = new Map(daily.map((d) => [d.trip_date, d.jobs_total]));

    const days = dates.map((d) =>
      dayLine(d, kmByDay.get(d) ?? 0, jobsByDay.get(d) ?? 0, punchesByDay.get(d) ?? []),
    );

    // Totals are built from the month's own sums, not from adding up the day
    // lines' đồng: the kilometres are summed first and priced once, for the same
    // reason the per-job figures are display-only.
    const totalKm = days.reduce((s, d) => s + d.km, 0);
    const totalMins = days.reduce((s, d) => s + d.worked_mins, 0);
    const roundedKm = Math.round(totalKm * 100) / 100;

    return NextResponse.json({
      ok: true,
      driver_name: session.driver_name,
      month: askedMonth,
      from, to, latest,
      rates,
      // The arrows' bounds, so the client never has to know when data began.
      prev_month: addMonths(askedMonth, -1),
      next_month: askedMonth < monthOf(latest) ? addMonths(askedMonth, 1) : null,
      summary: {
        days: days.filter((d) => d.jobs > 0 || d.worked_mins > 0).length,
        jobs: days.reduce((s, d) => s + d.jobs, 0),
        km: roundedKm,
        worked_mins: totalMins,
        hour_pay: hourPayFor(totalMins),
        km_pay: kmPayFor(roundedKm),
        total_pay: hourPayFor(totalMins) + kmPayFor(roundedKm),
        open_in_days: days.filter((d) => d.open_in.length > 0).length,
      },
      days,
    });
  } catch (e) {
    console.error("[pay/me] month error:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { ok: false, error: "Không tải được bảng thu nhập. Vui lòng thử lại sau." },
      { status: 200 },
    );
  }
}
