import { NextRequest, NextResponse } from "next/server";
import { writeConfigRows, completeConfigRow } from "@/lib/sheets-writer";
import { splitDriverNames, DRIVER_SEP } from "@/lib/driver-cell";
import { loadDriversFromSheet, invalidateConfigCache } from "@/lib/config";
import { timeToMins } from "@/lib/time";

/**
 * Close an uncovered hour by SPLITTING it out into its own rule, rather than
 * stretching a neighbour.
 *
 * The third way to close a gap, and often the honest one: when nobody on either
 * side actually works that stretch, widening their hours to cover it records
 * something untrue about who is on duty. A rule of its own says what is really
 * happening — this person covers this window — which is also what makes the
 * roster readable later.
 *
 * Built from the two writes that already exist rather than a third path: the row
 * is created empty and then completed, so it inherits both sets of guards — the
 * column-by-name lookup that can never touch an id column, and the re-read that
 * refuses if the row moved underneath.
 */
export async function POST(req: NextRequest) {
  const bad = (msg: string, code = 400) => NextResponse.json({ ok: false, error: msg }, { status: code });
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return bad("Body không hợp lệ");
    const { pickup_name, dropoff_name, driver_name, shift_start, shift_end } = body as {
      pickup_name?: string; dropoff_name?: string; driver_name?: string;
      shift_start?: string; shift_end?: string;
    };

    const pickup = (pickup_name ?? "").trim();
    const name = (driver_name ?? "").trim();
    const start = (shift_start ?? "").trim(), end = (shift_end ?? "").trim();
    if (!pickup) return bad("Thiếu tên điểm lấy mẫu");
    if (!name) return bad("Chưa chọn tài xế");
    // A new rule MUST carry a window. Without one it covers the whole day and
    // would immediately clash with the very rules it was meant to sit between.
    if (!start || !end) return bad("Dòng mới phải có khung giờ, nếu không sẽ trùng với các ca sẵn có");
    const a = timeToMins(start), b = timeToMins(end);
    if (!(a >= 0 && b >= 0)) return bad(`Khung giờ không hợp lệ: ${start}–${end}`);
    if (a === b) return bad("Giờ bắt đầu và kết thúc trùng nhau — dòng sẽ không bao giờ trực");

    // Name by name: several, comma-separated, is a smart row — the engine ranks
    // them by distance instead of always using one person. See splitDriverNames.
    const drivers = await loadDriversFromSheet();
    if (drivers.length === 0) return bad("Chưa đọc được danh sách tài xế — thử lại sau", 503);
    const names = splitDriverNames(name);
    const unknown = names.find((n) => !drivers.some((d) => d.name === n));
    if (unknown) return bad(`"${unknown}" không có trong tab Driver — chọn từ danh sách`);

    const [row] = await writeConfigRows([
      { pickup, dropoff: (dropoff_name ?? "").trim(), start, end },
    ]);
    await completeConfigRow({ row, expectPickup: pickup, driverName: names.join(DRIVER_SEP) });
    await invalidateConfigCache();

    return NextResponse.json({ ok: true, row });
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e), 409);
  }
}
