import { NextRequest, NextResponse } from "next/server";
import {
  loadShiftIndex,
  shiftDayForDriver,
  coversDate,
  type ShiftDay,
} from "@/lib/shift-window";

/**
 * What one driver was SCHEDULED to work, on the handful of days a form is
 * asking about.
 *
 * `shift-window.ts` reads the whole roster for the caller; this is only the door
 * that lets a browser ask it. The leave form uses it twice over: to prefill a
 * half-day window with the driver's own hours rather than a guessed 08:00, and
 * to say beside a chosen date whether that person was even rostered that day —
 * a full day of leave filed on a day off is almost always the wrong date.
 *
 * `unknown` IS PASSED THROUGH AS ITSELF. The schedule covers a rolling two-month
 * window and, when last measured, only about half the part-time accounts, so
 * "we have no row for this" is the common answer rather than the exceptional
 * one. Flattening it into "not working" here would let the form tell a
 * supervisor a driver is off when nobody knows — see the module header.
 */

/** Small by intent: this answers a form, not a report. It also bounds the work
 *  per request, and matches the leave form's own one-month ceiling. */
const MAX_DATES = 31;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const driverId = req.nextUrl.searchParams.get("driver_id")?.trim() ?? "";
  const raw = req.nextUrl.searchParams.get("dates") ?? "";
  const dates = [...new Set(raw.split(",").map((d) => d.trim()).filter(Boolean))];

  if (!driverId) {
    return NextResponse.json({ error: "driver_id required" }, { status: 400 });
  }
  if (dates.length === 0) {
    return NextResponse.json({ error: "dates required" }, { status: 400 });
  }
  if (dates.length > MAX_DATES) {
    return NextResponse.json({ error: `Tối đa ${MAX_DATES} ngày mỗi lần` }, { status: 400 });
  }
  if (!dates.every((d) => DATE_RE.test(d))) {
    return NextResponse.json({ error: "dates must be YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const index = await loadShiftIndex();
    const days: Record<string, ShiftDay & { covered: boolean }> = {};
    for (const d of dates) {
      days[d] = { ...shiftDayForDriver(index, driverId, d), covered: coversDate(index, d) };
    }
    return NextResponse.json({
      days,
      // The span the schedule actually holds, so a caller can say "outside the
      // roster" once instead of repeating "unknown" beside every date.
      from: index.from,
      to: index.to,
      degraded: index.degraded,
    });
  } catch (e) {
    console.error("[shift]", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
