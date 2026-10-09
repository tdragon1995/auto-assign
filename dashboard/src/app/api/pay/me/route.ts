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
import { sbSelectAll, supabaseConfigured } from "@/lib/supabase-rest";
import { masterDriverNames } from "@/lib/master-store";
import { employmentOf } from "@/lib/driver-label";
import {
  paidDay, hoursPayFor, kmPayFor, punchAt,
  RATE_PER_HOUR_VND, RATE_PER_KM_VND,
  type PayPunch, type PayJob, type DayFacts,
} from "@/lib/pay";
import { payrollPeriod } from "@/lib/pay-period";
import { staffCode } from "@/lib/display-names";
import { loadPayDayInputs, dayKey, type CorrectionRow } from "@/lib/pay-days";
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
  first_pickup_ts: string | null;
  last_dropoff_ts: string | null;
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

const monthOf = (date: string) => date.slice(0, 7);
function addMonths(m: string, n: number): string {
  const d = new Date(`${m}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}

/** One day's line on the month view. The hours are derived HERE, from the stored
 *  taps and payroll's imported shift, rather than read from a column — that is
 *  what makes the rule replaceable without re-archiving anything. See
 *  pay.ts/workedMinutes. */
function dayLine(code: string, facts: DayFacts, km: number, jobs: number, punches: PayPunch[], unpriced = 0, request: CorrectionRow | null = null) {
  const date = facts.date;
  const worked = paidDay(punches, facts, code);
  return {
    date,
    jobs,
    /** Completed trips with no distance yet: they pay NOTHING and the driver can
     *  only find them by opening every day, so the count travels with the day. */
    unpriced,
    km: Math.round(km * 100) / 100,
    worked_mins: worked.minutes,
    /** Of those, paid at the BO Runner rate. */
    bo_mins: worked.bo_minutes,
    spans: worked.spans.map((s) => ({ from: hhmm(s.from), to: hhmm(s.to), minutes: s.minutes })),
    /** Worked with no shift in Lịch ca: no hours paid for this day. */
    no_shift: worked.no_shift,
    /** The latest "cập nhật công" for the day, if any — the driver sees its state. */
    correction: request && {
      status: request.status, reason: request.reason,
      in_time: request.in_time.slice(0, 5), out_time: request.out_time.slice(0, 5),
      decision_note: request.decision_note,
    },
    hour_pay: hoursPayFor(worked.minutes, worked.bo_minutes),
    km_pay: kmPayFor(km),
    total_pay: hoursPayFor(worked.minutes, worked.bo_minutes) + kmPayFor(km),
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
  const code = staffCode(session.driver_name);
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
      const [jobs, punches, inputs] = await Promise.all([
        sbSelectAll<PayJob>(
          "pay_jobs",
          `select=*&driver_id=eq.${driverId}&trip_date=eq.${askedDate}`,
          "dropoff_completed_ts.asc,job_id.asc",
        ),
        sbSelectAll<PayPunch>(
          "pay_punches",
          `select=*&driver_id=eq.${driverId}&trip_date=eq.${askedDate}`,
          "id.asc",
        ),
        loadPayDayInputs(askedDate, askedDate, driverId),
      ]);
      const key = dayKey(driverId, askedDate);

      // Same VN date only, as v_pay_daily does: a job finished the next morning
      // must not stretch this day's shift overnight.
      const stamps = (xs: (string | null)[]) => xs
        .filter((t): t is string => t !== null && vnDate(new Date(t)) === askedDate)
        .sort((a, b) => Date.parse(a) - Date.parse(b));
      const facts: DayFacts = {
        date: askedDate,
        shifts: inputs.shifts.get(key) ?? [],
        firstTaskAt: stamps(jobs.map((j) => j.pickup_completed_ts))[0] ?? null,
        lastTaskAt: stamps(jobs.map((j) => j.dropoff_completed_ts)).at(-1) ?? null,
        correction: inputs.approved.get(key) ?? null,
      };
      const km = jobs.reduce((sum, j) => sum + num(j.distance_km), 0);
      return NextResponse.json({
        ok: true,
        date: askedDate,
        rates,
        day: dayLine(code, facts, km, jobs.length, punches, jobs.filter((j) => j.distance_km == null).length, inputs.latest.get(key) ?? null),
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
  const askedMonth = sp.get("month") ?? monthOf(vnDate());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(askedMonth)) {
    return NextResponse.json({ ok: false, error: "Tháng không hợp lệ." }, { status: 400 });
  }
  const { from, to: periodEnd } = payrollPeriod(askedMonth);
  // A month still running ends at the last sealed day, not at its own last date.
  const to = periodEnd > latest ? latest : periodEnd;

  try {
    if (to < from) {
      // A month that has not started yet — the "next month" arrow can reach it.
      return NextResponse.json({
        ok: true, driver_name: (await masterDriverNames([driverId])).get(driverId)||session.driver_name, month: askedMonth, from, to: from,
        rates, latest, days: [],
        summary: { days: 0, jobs: 0, km: 0, worked_mins: 0, hour_pay: 0, km_pay: 0, total_pay: 0, no_shift_days: 0, unpriced_jobs: 0 },
      });
    }

    const [daily, punches, names, inputs] = await Promise.all([
      sbSelectAll<DailyRow>(
        "v_pay_daily",
        `select=*&driver_id=eq.${driverId}&trip_date=gte.${from}&trip_date=lte.${to}`,
        "trip_date.asc",
      ),
      sbSelectAll<PayPunch>(
        "pay_punches",
        `select=*&driver_id=eq.${driverId}&trip_date=gte.${from}&trip_date=lte.${to}`,
        "id.asc",
      ),
      masterDriverNames([driverId]),
      loadPayDayInputs(from, to, driverId),
    ]);

    const punchesByDay = new Map<string, PayPunch[]>();
    for (const p of punches) {
      const list = punchesByDay.get(p.trip_date);
      if (list) list.push(p); else punchesByDay.set(p.trip_date, [p]);
    }

    // A day a driver clocked in but was dispatched nothing has punches and no
    // job row, so the union of both sources is what makes a day exist — reading
    // only the job rollup would stop paying for exactly those days.
    // ...and a day with only a correction on it (approved or still waiting) exists too.
    const dates = [...new Set([
      ...daily.map((d) => d.trip_date), ...punchesByDay.keys(),
      ...inputs.corrections.filter((c) => c.status !== "withdrawn").map((c) => c.trip_date),
    ])].sort();
    const kmByDay = new Map(daily.map((d) => [d.trip_date, num(d.total_km)]));
    const jobsByDay = new Map(daily.map((d) => [d.trip_date, d.jobs_total]));
    const unpricedByDay = new Map(daily.map((d) => [d.trip_date, d.jobs_total - d.jobs_priced]));

    const taskByDay = new Map(daily.map((d) => [d.trip_date, d]));
    const days = dates.map((d) =>
      dayLine(code, {
        date: d,
        shifts: inputs.shifts.get(dayKey(driverId, d)) ?? [],
        firstTaskAt: taskByDay.get(d)?.first_pickup_ts ?? null,
        lastTaskAt: taskByDay.get(d)?.last_dropoff_ts ?? null,
        correction: inputs.approved.get(dayKey(driverId, d)) ?? null,
      }, kmByDay.get(d) ?? 0, jobsByDay.get(d) ?? 0, punchesByDay.get(d) ?? [], unpricedByDay.get(d) ?? 0,
        inputs.latest.get(dayKey(driverId, d)) ?? null),
    );

    // Totals are built from the month's own sums, not from adding up the day
    // lines' đồng: the kilometres are summed first and priced once, for the same
    // reason the per-job figures are display-only.
    const totalKm = days.reduce((s, d) => s + d.km, 0);
    const totalMins = days.reduce((s, d) => s + d.worked_mins, 0);
    const boMins = days.reduce((s, d) => s + d.bo_mins, 0);
    const roundedKm = Math.round(totalKm * 100) / 100;

    return NextResponse.json({
      ok: true,
      driver_name: names.get(driverId) || session.driver_name,
      month: askedMonth,
      from, to, latest,
      rates,
      // The arrows' bounds, so the client never has to know when data began.
      prev_month: addMonths(askedMonth, -1),
      next_month: askedMonth < monthOf(vnDate()) ? addMonths(askedMonth, 1) : null,
      summary: {
        days: days.filter((d) => d.jobs > 0 || d.worked_mins > 0).length,
        jobs: days.reduce((s, d) => s + d.jobs, 0),
        km: roundedKm,
        worked_mins: totalMins,
        hour_pay: hoursPayFor(totalMins, boMins),
        km_pay: kmPayFor(roundedKm),
        total_pay: hoursPayFor(totalMins, boMins) + kmPayFor(roundedKm),
        no_shift_days: inputs.payrollImported ? days.filter((d) => d.no_shift).length : 0,
        pending_corrections: days.filter((d) => d.correction?.status === "pending").length,
        // One number the driver can act on without opening thirty days.
        unpriced_jobs: days.reduce((s, d) => s + d.unpriced, 0),
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
