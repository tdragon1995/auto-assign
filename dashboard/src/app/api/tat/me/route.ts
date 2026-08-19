/**
 * The driver's own TAT report.
 *
 * AUTHORIZATION — the driver_id comes from the signed HttpOnly nv_session cookie
 * and NEVER from a query parameter or body. This is the rule /api/driver-jobs
 * follows and for the same reason: a readable id in the request would let any
 * driver type someone else's uuid and read their performance record.
 *
 * FRESHNESS — reads are served from Supabase immediately, even when today's rows
 * are a little behind, and a refresh is scheduled with after() so it lands before
 * the driver's next look. Blocking the response on a full Cartrack day-fetch would
 * put a couple of seconds in front of every page open to move a number that is
 * rarely the one being looked at. The response carries `updated_at` so the screen
 * can state its own age rather than implying it is live.
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
 *  Matched to a sensible cron cadence rather than to the assign cycle: this is a
 *  reflective report, and a leg appearing a few minutes after it was ridden costs
 *  nothing. Lower would just mean more drivers each paying for a day-fetch. */
const STALE_MS = 15 * 60 * 1000;

interface DailyRow extends TatRollupRow {
  trip_date: string;
  avg_tat_mins: number | null;
}

/** One row on the driver's leg list. Times are pre-formatted to HH:mm — the
 *  client should not be re-deriving VN local time from a timestamp. */
interface LegCard {
  seq: number;
  from: string | null;
  to: string | null;
  left_at: string | null;
  arrived_at: string | null;
  distance_km: number | null;
  tat_mins: number | null;
  target_mins: number | null;
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

/** Monday of the week containing `date`. Date-only arithmetic in UTC so no
 *  timezone or DST shift can move the boundary. */
function weekStart(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

function toCard(l: TatLeg & { archived_at?: string }): LegCard {
  return {
    seq: l.seq,
    from: l.from_name,
    to: l.to_name,
    left_at: hhmm(l.departed_ts),
    arrived_at: hhmm(l.arrived_ts),
    distance_km: l.distance_km == null ? null : Number(l.distance_km),
    tat_mins: l.tat_mins,
    target_mins: l.target_mins,
    on_time: l.on_time,
    long_gap: l.long_gap,
    // The driver never tapped "đã đến", so the arrival stamp is really the
    // completion stamp and the minutes include time spent at the destination.
    // Surfaced so the screen can say so rather than presenting an inflated
    // number as measured fact.
    estimated: l.tat_basis === "completed",
  };
}

const emptySummary = (): TatSummary => summarize([]);

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

  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const driverId = session.driver_id;
  const today = vnDate();
  const wStart = weekStart(today);
  const mStart = monthStart(today);
  const prevWStart = addDays(wStart, -7);
  const prevWEnd = addDays(wStart, -1);

  // One rollup query covering every span the report shows, sliced in memory. The
  // earliest boundary is whichever of "this month" and "last week" starts first —
  // in the first days of a month, that is last week.
  const rangeStart = mStart < prevWStart ? mStart : prevWStart;

  try {
    const [todayLegs, daily] = await Promise.all([
      sbSelect<TatLeg & { archived_at?: string }>(
        "tat_legs",
        `select=*&driver_id=eq.${driverId}&trip_date=eq.${today}&order=seq.asc`,
      ),
      sbSelect<DailyRow>(
        "v_tat_daily",
        `select=*&driver_id=eq.${driverId}&trip_date=gte.${rangeStart}&trip_date=lte.${today}&order=trip_date.asc`,
      ),
    ]);

    const inRange = (from: string, to: string) => daily.filter((d) => d.trip_date >= from && d.trip_date <= to);
    const weekDays = inRange(wStart, today);

    // Age of today's data, taken from the rows themselves rather than a separate
    // marker — a marker can outlive the rows it claims to describe.
    const archivedAt = todayLegs.reduce<number>((max, l) => {
      const ts = Date.parse(l.archived_at ?? "");
      return Number.isFinite(ts) && ts > max ? ts : max;
    }, 0);
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
      today: {
        date: today,
        summary: summarizeLegs(todayLegs),
        legs: todayLegs.map(toCard),
      },
      week: {
        from: wStart,
        to: today,
        summary: summarize(weekDays),
        // One row per day the driver actually worked; days with no legs are absent
        // rather than rendered as zeros, which would read as a bad day, not a day off.
        days: weekDays.map((d) => ({
          date: d.trip_date,
          legs: d.trips_total,
          avg_tat_mins: d.avg_tat_mins,
          on_time_pct: d.trips_graded > 0 ? Math.round((d.trips_on_time / d.trips_graded) * 100) : null,
        })),
      },
      prev_week: { from: prevWStart, to: prevWEnd, summary: summarize(inRange(prevWStart, prevWEnd)) },
      month: { from: mStart, to: today, summary: summarize(inRange(mStart, today)) },
    });
  } catch (e) {
    console.error("[tat/me] error:", e instanceof Error ? e.message : e);
    // Degrade to an empty-but-valid report rather than an error status: the tab
    // should render its own explanation, not a broken screen.
    return NextResponse.json({
      ok: true,
      driver_name: session.driver_name,
      mins_per_km: MINS_PER_KM,
      degraded: "Không tải được báo cáo. Vui lòng thử lại sau.",
      updated_at: null,
      refreshing: false,
      today: { date: today, summary: emptySummary(), legs: [] },
      week: { from: wStart, to: today, summary: emptySummary(), days: [] },
      prev_week: { from: prevWStart, to: prevWEnd, summary: emptySummary() },
      month: { from: mStart, to: today, summary: emptySummary() },
    });
  }
}
