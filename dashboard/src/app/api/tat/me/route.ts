/**
 * The driver's own TAT report.
 *
 * AUTHORIZATION — the driver_id comes from the signed HttpOnly nv_session cookie
 * and NEVER from a query parameter or body. This is the rule /api/driver-jobs
 * follows and for the same reason: a readable id in the request would let any
 * driver type someone else's uuid and read their performance record.
 *
 * TWO MODES
 *   (no params)  → the dashboard: today's legs, plus week / last week / this
 *                  month / LAST MONTH rollups and their day lists.
 *   ?date=YYYY-MM-DD → one day's legs, for drilling into a past day.
 *
 * LAST MONTH is not a nicety. Payroll runs on the 25th and evaluates the month
 * before, so for the report's main institutional use "this month" is the wrong
 * month — the number people are actually paid against was previously unreachable.
 *
 * FRESHNESS — reads are served from Supabase immediately, and a refresh is queued
 * with after() when the day asked for is missing or stale. Blocking the response
 * on a Cartrack day-fetch would put 30+ seconds in front of a page open.
 */
import { NextRequest, NextResponse, after } from "next/server";
import { verifySession, NV_COOKIE } from "@/lib/driver-session";
import { sbSelect, supabaseConfigured } from "@/lib/supabase-rest";
import {
  summarize, summarizeLegs, MINS_PER_KM, type TatRollupRow, type TatSummary, type TatLeg,
} from "@/lib/tat";
import { archiveDay } from "@/lib/tat-archive";
import { vnDate, addDays } from "@/lib/time";
import type { Env } from "@/lib/cartrack";

export const runtime = "nodejs";
export const maxDuration = 60;
export const preferredRegion = "sin1";

/** How far behind today's archive may fall before a background refresh is queued.
 *  This is a reflective report; a leg appearing a few minutes after it was ridden
 *  costs nothing, and a tighter window would just make more drivers each pay for a
 *  day-fetch. */
const STALE_MS = 15 * 60 * 1000;

interface DailyRow extends TatRollupRow {
  trip_date: string;
  avg_tat_mins: number | null;
}

/** One row on the driver's leg list. Times are pre-formatted to HH:mm — the client
 *  should not be re-deriving VN local time from a timestamp. */
interface LegCard {
  seq: number;
  from: string | null;
  to: string | null;
  left_at: string | null;
  arrived_at: string | null;
  distance_km: number | null;
  tat_mins: number | null;
  target_mins: number | null;
  /** Goong's estimate for the same leg. Shown beside the target, never used to grade. */
  eta_mins: number | null;
  on_time: boolean | null;
  long_gap: boolean;
  estimated: boolean;
}

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false,
});

const hhmm = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : timeFmt.format(d);
};

/** Monday of the week containing `date`. Date-only arithmetic in UTC so no timezone
 *  or DST shift can move the boundary. */
function weekStart(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
/** Last day of the month containing `date` — day 0 of the next month. */
function monthEnd(date: string): string {
  const d = new Date(`${monthStart(date)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
/** Any day inside the previous month. */
const prevMonthAnchor = (date: string) => addDays(monthStart(date), -1);

function toCard(l: TatLeg): LegCard {
  return {
    seq: l.seq,
    from: l.from_name,
    to: l.to_name,
    left_at: hhmm(l.departed_ts),
    arrived_at: hhmm(l.arrived_ts),
    distance_km: l.distance_km == null ? null : Number(l.distance_km),
    tat_mins: l.tat_mins,
    target_mins: l.target_mins,
    eta_mins: l.eta_mins ?? null,
    on_time: l.on_time,
    long_gap: l.long_gap,
    // The driver never tapped "đã đến", so the arrival stamp is really the
    // completion stamp and the minutes include time spent at the destination.
    estimated: l.tat_basis === "completed",
  };
}

const emptySummary = (): TatSummary => summarize([]);

const dayRow = (d: DailyRow) => ({
  date: d.trip_date,
  legs: d.trips_total,
  avg_tat_mins: d.avg_tat_mins,
  on_time_pct: d.trips_graded > 0 ? Math.round((d.trips_on_time / d.trips_graded) * 100) : null,
});

async function legsForDay(driverId: string, date: string) {
  return sbSelect<TatLeg & { archived_at?: string }>(
    "tat_legs",
    `select=*&driver_id=eq.${driverId}&trip_date=eq.${date}&order=seq.asc`,
  );
}

/** Newest archived_at across a day's rows, or 0 when the day has none. Read off the
 *  rows themselves rather than a separate marker, which could outlive what it
 *  claims to describe. */
const archivedAtOf = (legs: { archived_at?: string }[]): number =>
  legs.reduce<number>((max, l) => {
    const ts = Date.parse(l.archived_at ?? "");
    return Number.isFinite(ts) && ts > max ? ts : max;
  }, 0);

export async function GET(req: NextRequest) {
  const session = verifySession(req.cookies.get(NV_COOKIE)?.value);
  if (!session) {
    return NextResponse.json(
      { ok: false, expired: true, error: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại." },
      { status: 401 },
    );
  }

  if (!supabaseConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Báo cáo chưa sẵn sàng — hệ thống lưu trữ chưa được cấu hình." },
      { status: 503 },
    );
  }

  const sp = req.nextUrl.searchParams;
  const env = (sp.get("env") ?? "prod") as Env;
  const driverId = session.driver_id;
  const today = vnDate();

  // ── Day-detail mode ───────────────────────────────────────────────────────
  const askedDate = sp.get("date");
  if (askedDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(askedDate) || askedDate > today) {
      return NextResponse.json({ ok: false, error: "Ngày không hợp lệ." }, { status: 400 });
    }
    try {
      const legs = await legsForDay(driverId, askedDate);
      const archivedAt = archivedAtOf(legs);
      // A past day with no rows has simply never been archived (the nightly seal
      // only reaches back three days). Fetch it in the background so the same tap
      // a moment later finds it, rather than showing a permanent blank.
      const stale = legs.length === 0 || (askedDate === today && Date.now() - archivedAt > STALE_MS);
      if (stale) {
        after(async () => {
          try { await archiveDay(askedDate, env); }
          catch (e) { console.error("[tat/me] background archive failed:", e instanceof Error ? e.message : e); }
        });
      }
      return NextResponse.json({
        ok: true, date: askedDate, refreshing: stale,
        summary: summarizeLegs(legs), legs: legs.map(toCard),
      });
    } catch (e) {
      console.error("[tat/me] day error:", e instanceof Error ? e.message : e);
      return NextResponse.json({ ok: false, error: "Không tải được dữ liệu ngày này." }, { status: 200 });
    }
  }

  // ── Dashboard mode ────────────────────────────────────────────────────────
  const wStart = weekStart(today);
  const mStart = monthStart(today);
  const prevWStart = addDays(wStart, -7);
  const prevWEnd = addDays(wStart, -1);
  const pmAnchor = prevMonthAnchor(today);
  const pmStart = monthStart(pmAnchor);
  const pmEnd = monthEnd(pmAnchor);

  // One rollup query covering every span, sliced in memory. The earliest boundary
  // is whichever of last month and last week starts first — ~60 rows for one driver.
  const rangeStart = pmStart < prevWStart ? pmStart : prevWStart;

  try {
    const [todayLegs, daily] = await Promise.all([
      legsForDay(driverId, today),
      sbSelect<DailyRow>(
        "v_tat_daily",
        `select=*&driver_id=eq.${driverId}&trip_date=gte.${rangeStart}&trip_date=lte.${today}&order=trip_date.asc`,
      ),
    ]);

    const inRange = (from: string, to: string) => daily.filter((d) => d.trip_date >= from && d.trip_date <= to);
    const weekDays = inRange(wStart, today);
    const monthDays = inRange(mStart, today);
    const prevMonthDays = inRange(pmStart, pmEnd);

    const archivedAt = archivedAtOf(todayLegs);
    const stale = archivedAt === 0 || Date.now() - archivedAt > STALE_MS;

    // Refresh AFTER responding. The archive rewrites the whole fleet's day, so one
    // driver opening the tab warms it for everyone who opens it next.
    if (stale) {
      after(async () => {
        try { await archiveDay(today, env); }
        catch (e) { console.error("[tat/me] background archive failed:", e instanceof Error ? e.message : e); }
      });
    }

    return NextResponse.json({
      ok: true,
      driver_name: session.driver_name,
      mins_per_km: MINS_PER_KM,
      updated_at: archivedAt ? new Date(archivedAt).toISOString() : null,
      refreshing: stale,
      today: { date: today, summary: summarizeLegs(todayLegs), legs: todayLegs.map(toCard) },
      // Days with no legs are absent rather than zero rows — a day off should not
      // render as a bad day.
      week: { from: wStart, to: today, summary: summarize(weekDays), days: weekDays.map(dayRow) },
      prev_week: { from: prevWStart, to: prevWEnd, summary: summarize(inRange(prevWStart, prevWEnd)) },
      month: { from: mStart, to: today, summary: summarize(monthDays), days: monthDays.map(dayRow) },
      prev_month: { from: pmStart, to: pmEnd, summary: summarize(prevMonthDays), days: prevMonthDays.map(dayRow) },
    });
  } catch (e) {
    console.error("[tat/me] error:", e instanceof Error ? e.message : e);
    // Degrade to an empty-but-valid report rather than an error status: the tab
    // should render its own explanation, not a broken screen.
    const empty = { from: today, to: today, summary: emptySummary(), days: [] as ReturnType<typeof dayRow>[] };
    return NextResponse.json({
      ok: true,
      driver_name: session.driver_name,
      mins_per_km: MINS_PER_KM,
      degraded: "Không tải được báo cáo. Vui lòng thử lại sau.",
      updated_at: null,
      refreshing: false,
      today: { date: today, summary: emptySummary(), legs: [] },
      week: empty, prev_week: { ...empty, summary: emptySummary() },
      month: empty, prev_month: empty,
    });
  }
}
