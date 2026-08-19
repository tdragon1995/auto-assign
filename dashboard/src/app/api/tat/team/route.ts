/**
 * Every driver's TAT for one month — the supervisor view behind the 25th payroll
 * evaluation.
 *
 * SCOPE, AND WHAT IT IS NOT. /api/tat/me answers "how did I do" for one
 * authenticated driver. This answers "how did everyone do" and is therefore a
 * different kind of data: one person's record versus a comparison across staff.
 * It carries NO driver session — it follows the dashboard's existing posture,
 * which has no auth of any kind. That is a deliberate inheritance, not an
 * oversight; if the dashboard ever gets a gate, this route must end up behind it.
 *
 * Reads only the daily rollup, never the legs. A month across ~80 drivers is
 * ~2,500 rollup rows against ~35,000 legs, and nothing here needs a single leg.
 */
import { NextRequest, NextResponse } from "next/server";
import { sbSelect, supabaseConfigured } from "@/lib/supabase-rest";
import { summarize, MINS_PER_KM, type TatRollupRow } from "@/lib/tat";
import { vnDate } from "@/lib/time";

export const runtime = "nodejs";
export const maxDuration = 30;
export const preferredRegion = "sin1";

interface DailyRow extends TatRollupRow {
  driver_id: string;
  driver_name: string | null;
  trip_date: string;
}

/** PostgREST caps a response at 1,000 rows by default and says so only by
 *  returning exactly that many — a silent truncation that would drop whole
 *  drivers off the end of a month. Page until a short page arrives. */
async function selectAllPages<T>(table: string, query: string): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await sbSelect<T>(table, `${query}&limit=${PAGE}&offset=${offset}`);
    out.push(...page);
    if (page.length < PAGE) return out;
    // A month cannot legitimately exceed this; bail rather than loop forever.
    if (offset > 50_000) return out;
  }
}

/** First and last day of a "YYYY-MM" month. */
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
    return NextResponse.json(
      { ok: false, error: "Chưa cấu hình hệ thống lưu trữ." },
      { status: 503 },
    );
  }

  const today = vnDate();
  // Defaults to LAST month, because that is the month an evaluation on the 25th is
  // actually about. Defaulting to the current month would show a half-finished one.
  const month = req.nextUrl.searchParams.get("month") ?? prevMonthOf(today);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ ok: false, error: "month phải có dạng YYYY-MM" }, { status: 400 });
  }
  const { from, to } = monthRange(month);

  try {
    const rows = await selectAllPages<DailyRow>(
      "v_tat_daily",
      `select=*&trip_date=gte.${from}&trip_date=lte.${to}&order=trip_date.asc`,
    );

    const byDriver = new Map<string, { name: string | null; days: DailyRow[] }>();
    for (const r of rows) {
      const e = byDriver.get(r.driver_id) ?? { name: r.driver_name, days: [] };
      if (!e.name && r.driver_name) e.name = r.driver_name;
      e.days.push(r);
      byDriver.set(r.driver_id, e);
    }

    const drivers = [...byDriver.entries()].map(([driver_id, { name, days }]) => {
      const s = summarize(days);
      return {
        driver_id,
        // The FULL record name, staff code and all. It used to be trimmed here,
        // which quietly defeated the table's own formatting: with the code already
        // gone there was nothing left to show beside the name, and the two rows a
        // driver with both a part-time and a full-time account produces were
        // indistinguishable. Trimming happens once, on the way to the screen, so
        // the CSV can still carry the code that attendance and leave are keyed on.
        driver_name: name || driver_id.slice(0, 8),
        days_worked: days.length,
        ...s,
      };
    });

    // Ranked by on-time share, then by volume — a driver with 95% over 300 legs
    // has done something more than one with 100% over 12. Ungraded drivers sort
    // last rather than appearing to lead with a null.
    drivers.sort((a, b) =>
      (b.on_time_pct ?? -1) - (a.on_time_pct ?? -1) || b.trips_total - a.trips_total,
    );

    return NextResponse.json({
      ok: true,
      month, from, to,
      mins_per_km: MINS_PER_KM,
      driver_count: drivers.length,
      totals: summarize(rows),
      drivers,
    });
  } catch (e) {
    console.error("[tat/team] error:", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, error: "Không tải được báo cáo tháng." }, { status: 502 });
  }
}
