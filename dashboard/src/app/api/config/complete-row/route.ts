import { NextRequest, NextResponse } from "next/server";
import { completeConfigRow } from "@/lib/sheets-writer";
import { loadDriversFromSheet, invalidateConfigCache } from "@/lib/config";
import { timeToMins } from "@/lib/time";

/**
 * Finish a config line the engine created for an unconfigured branch: put a
 * driver on it, and correct the suggested hours.
 *
 * Modelled on the leave-substitute write, including the part that matters most —
 * the driver NAME is checked against the roster tab before anything is written.
 * That tab is what the sheet's own lookup resolves against, so a name that is
 * not in it writes perfectly well and then resolves to a blank id, leaving a row
 * that looks finished and assigns nobody.
 *
 * The cache IS invalidated here, unlike when the engine writes the empty row.
 * That row had no driver and nothing to act on; this one is a live rule the
 * moment it lands, and waiting for someone to press Refresh would leave the
 * branch failing for no reason.
 */
export async function POST(req: NextRequest) {
  const bad = (msg: string, code = 400) => NextResponse.json({ ok: false, error: msg }, { status: code });
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return bad("Body không hợp lệ");
    const { row, pickup_name, driver_name, shift_start, shift_end } = body as {
      row?: number; pickup_name?: string; driver_name?: string;
      shift_start?: string; shift_end?: string;
    };

    if (!Number.isInteger(row) || (row as number) < 2) return bad("Thiếu số dòng hợp lệ");
    if (!pickup_name?.trim()) return bad("Thiếu tên điểm lấy mẫu");
    const name = (driver_name ?? "").trim();
    if (!name) return bad("Chưa chọn tài xế");

    // Both or neither: a window with one end is worse than no window, because a
    // blank end reads as "all day" and the row would quietly cover everything.
    const start = (shift_start ?? "").trim(), end = (shift_end ?? "").trim();
    if (!!start !== !!end) return bad("Khung giờ phải đủ cả từ và đến");
    if (start && end) {
      const a = timeToMins(start), b = timeToMins(end);
      if (!(a >= 0 && b >= 0)) return bad(`Khung giờ không hợp lệ: ${start}–${end}`);
      if (a === b) return bad("Giờ bắt đầu và kết thúc trùng nhau — dòng sẽ không bao giờ trực");
    }

    // The roster is the sheet's own lookup source. A name that is not on it
    // resolves to a blank id, and the row would assign nobody while looking done.
    const drivers = await loadDriversFromSheet();
    if (drivers.length === 0) return bad("Chưa đọc được danh sách tài xế — thử lại sau", 503);
    if (!drivers.some((d) => d.name === name)) {
      return bad(`"${name}" không có trong tab Driver — chọn từ danh sách`);
    }

    await completeConfigRow({
      row: row as number,
      expectPickup: pickup_name,
      driverName: name,
      start: start || undefined,
      end: end || undefined,
    });
    // Now it is a real rule; make every server see it rather than waiting for
    // someone to press Refresh.
    await invalidateConfigCache();

    return NextResponse.json({ ok: true, row });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A stale row number or a Sunday attempt is the caller's to resolve, not a
    // server fault — say what happened rather than returning a bare 500.
    return bad(msg, 409);
  }
}
