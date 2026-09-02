import { NextRequest, NextResponse } from "next/server";
import {
  loadLeaveEntries,
  loadInvalidLeaveRows,
  leaveEntriesOnDate,
  invalidLeaveRowsOnDate,
  invalidateLeaveCache,
  spanningLeaveRows,
} from "@/lib/leave-config";
import {
  updateLeaveSubs, deleteLeaveRow, LeaveWriteError, type LeaveSubWrite,
} from "@/lib/sheets-writer";
import { loadDriversFromSheet } from "@/lib/config";
import { addDays, timeToMins, vnDate } from "@/lib/time";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

/** GET — drivers on leave today and tomorrow (Saigon dates), from the Leave
 *  Status sheet. Powers the dashboard "Cần xử lý" leave-status panel.
 *  `?fresh=1` busts the 5-min sheet cache first (dashboard Refresh button). */
export async function GET(req: NextRequest) {
  try {
    const fresh = !!new URL(req.url).searchParams.get("fresh");
    const entries = await loadLeaveEntries(fresh);
    // Shares the same cached parse as the call above — no second sheet read.
    const dropped = await loadInvalidLeaveRows();
    const today = vnDate();
    const tomorrow = addDays(today, 1);
    return NextResponse.json({
      today: leaveEntriesOnDate(today, entries),
      tomorrow: leaveEntriesOnDate(tomorrow, entries),
      // Rows the loader could not attach to a driver, so the panel can ask for a
      // sheet repair. They are NOT leave the engine knows about — see
      // InvalidLeaveRow.
      invalid: [
        ...invalidLeaveRowsOnDate(today, dropped),
        ...invalidLeaveRowsOnDate(tomorrow, dropped),
      ],
      // Rows spanning 2+ days. Not filtered to today/tomorrow like the rest: the
      // point of flagging one is to split it BEFORE the span starts, so anything
      // that has not finished yet is worth showing.
      spanning: spanningLeaveRows(entries, dropped, today),
    });
  } catch (e) {
    return NextResponse.json({ today: [], tomorrow: [], invalid: [], spanning: [], error: String(e) }, { status: 500 });
  }
}

/** POST — fill substitute(s) on a leave row that has none ("Chưa có người
 *  thay" in the panel). Body:
 *    { driver_id, leave_from, timeLabel, subs: [{ name, from, to }] }
 *  1–3 subs; with 2+ every sub needs its own non-overlapping HH:MM window
 *  (an open window covers the whole day, which would SUB CLASH the others).
 *  Sub names must match the Driver tab exactly — that's what the sheet's
 *  sub#_id xlookup resolves against; anything else is invisible to the engine. */
export async function POST(req: NextRequest) {
  const bad = (msg: string) => NextResponse.json({ ok: false, error: msg }, { status: 400 });
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return bad("Body không hợp lệ");
    const { driver_id, leave_from, timeLabel, subs } = body as {
      driver_id?: string;
      leave_from?: string;
      timeLabel?: string | null;
      subs?: { name?: string; from?: string | null; to?: string | null }[];
    };
    if (!driver_id || !leave_from) return bad("Thiếu driver_id / leave_from");
    if (!Array.isArray(subs) || subs.length < 1 || subs.length > 3)
      return bad("Cần 1–3 người thay");

    // Validate names against the Driver tab (the xlookup source). A name not in
    // that tab writes fine but resolves to a blank sub_id — the engine would
    // silently ignore it, so reject up front.
    const drivers = await loadDriversFromSheet();
    const idByName = new Map(drivers.map((d) => [d.name, d.driver_id]));
    const clean: LeaveSubWrite[] = [];
    for (const s of subs) {
      const name = (s.name ?? "").trim();
      if (!name) return bad("Người thay chưa được chọn");
      const subId = idByName.get(name);
      if (!subId) return bad(`"${name}" không có trong tab Driver — chọn từ danh sách`);
      if (subId === driver_id) return bad("Người thay trùng với tài xế đang nghỉ");
      const from = (s.from ?? "").trim() || null;
      const to = (s.to ?? "").trim() || null;
      if ((from === null) !== (to === null)) return bad("Khung giờ thay phải đủ cả từ và đến");
      if (from && to && !(timeToMins(from) >= 0 && timeToMins(to) > timeToMins(from)))
        return bad(`Khung giờ không hợp lệ: ${from}–${to}`);
      clean.push({ name, from, to });
    }
    if (clean.length > 1) {
      // Multiple subs must carve up the day: all windowed, no overlaps.
      // (Shared boundaries are fine — coverage windows are half-open (from, to].)
      if (clean.some((s) => !s.from || !s.to))
        return bad("Nhiều người thay thì mỗi người cần khung giờ riêng");
      const sorted = [...clean].sort((a, b) => timeToMins(a.from) - timeToMins(b.from));
      for (let i = 1; i < sorted.length; i++) {
        if (timeToMins(sorted[i].from) < timeToMins(sorted[i - 1].to))
          return bad(
            `Khung giờ bị chồng: ${sorted[i - 1].from}–${sorted[i - 1].to} và ${sorted[i].from}–${sorted[i].to}`,
          );
      }
    }

    const result = await updateLeaveSubs(
      { driver_id, leave_from, timeLabel: timeLabel ?? null },
      clean,
    );
    await invalidateLeaveCache();
    return NextResponse.json({ ok: true, row: result.row, warning: result.warning ?? null });
  } catch (e) {
    // Business rejections (row full, row not found, bad input) are the user's to
    // fix → 400 with the message verbatim; anything else is a real 500.
    if (e instanceof LeaveWriteError) return bad(e.message);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

/** DELETE — remove ONE leave row from the sheet. Body:
 *    { driver_id, leave_from, timeLabel }
 *  — the same identity the sub-fill uses, re-resolved against the sheet at write
 *  time rather than trusting a row number the dashboard is holding.
 *
 *  The case it is for: MISA approves a leave request only in PART. The sync has
 *  already written a row per charged day, and cancelling the rest in MISA does
 *  not reach back into this sheet — so without this the engine keeps the driver
 *  off on days they are working, and their lane fails every cycle.
 *
 *  Only ever one row per call. Where the sheet holds the duplicate pair the
 *  panel flags, the UNCOVERED copy goes first and the response says how many
 *  identical rows are left, so a real record is never taken out by a stray click.
 */
export async function DELETE(req: NextRequest) {
  const bad = (msg: string) => NextResponse.json({ ok: false, error: msg }, { status: 400 });
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return bad("Body không hợp lệ");
    const { driver_id, leave_from, timeLabel } = body as {
      driver_id?: string;
      leave_from?: string;
      timeLabel?: string | null;
    };
    if (!driver_id || !leave_from) return bad("Thiếu driver_id / leave_from");

    const deleted = await deleteLeaveRow({
      driver_id,
      leave_from,
      timeLabel: timeLabel ?? null,
    });
    await invalidateLeaveCache();
    return NextResponse.json({ ok: true, deleted });
  } catch (e) {
    if (e instanceof LeaveWriteError) return bad(e.message);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
