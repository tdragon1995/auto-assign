import { NextRequest, NextResponse } from "next/server";
import { bulkUpdateConfigRows } from "@/lib/sheets-writer";
import { splitDriverNames, DRIVER_SEP } from "@/lib/driver-cell";
import { loadDriversFromSheet, invalidateConfigCache } from "@/lib/config";
import { parseConfigTargets } from "@/lib/config-targets";
import { timeToMins } from "@/lib/time";

/**
 * The Config tab's bulk "Đổi tài xế" / "Đổi ca": one driver cell or one window
 * written onto every ticked row, in one Sheets write.
 *
 * It replaces a loop of complete-row calls that ran out of Google's per-minute
 * read quota after ~25 rows (see bulkUpdateConfigRows). The checks are
 * complete-row's: every name on the roster, a window with both ends that are not
 * equal. The cache is bumped once.
 */
export async function POST(req: NextRequest) {
  const bad = (msg: string, code = 400) => NextResponse.json({ ok: false, error: msg }, { status: code });
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return bad("Body không hợp lệ");
    const { rows, driver_name, shift_start, shift_end } = body as {
      rows?: unknown; driver_name?: string; shift_start?: string; shift_end?: string;
    };
    const parsed = parseConfigTargets(rows);
    if ("error" in parsed) return bad(parsed.error);

    const start = (shift_start ?? "").trim(), end = (shift_end ?? "").trim();
    if (!!start !== !!end) return bad("Khung giờ phải đủ cả từ và đến");
    if (start) {
      const a = timeToMins(start), b = timeToMins(end);
      if (!(a >= 0 && b >= 0)) return bad(`Khung giờ không hợp lệ: ${start}–${end}`);
      if (a === b) return bad("Giờ bắt đầu và kết thúc trùng nhau — dòng sẽ không bao giờ trực");
    }

    let driverName: string | undefined;
    if (typeof driver_name === "string") {
      const names = splitDriverNames(driver_name);
      if (names.length === 0) return bad("Chưa chọn tài xế");
      const drivers = await loadDriversFromSheet();
      if (drivers.length === 0) return bad("Chưa đọc được danh sách tài xế — thử lại sau", 503);
      const unknown = names.find((n) => !drivers.some((d) => d.name === n));
      if (unknown) return bad(`"${unknown}" không có trong tab Driver — chọn từ danh sách`);
      driverName = names.join(DRIVER_SEP);
    }
    if (driverName === undefined && !start) return bad("Không có gì để ghi");

    const result = await bulkUpdateConfigRows({
      targets: parsed.targets,
      driverName,
      start: start || undefined,
      end: end || undefined,
    });
    if (result.done.length > 0) await invalidateConfigCache();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // A Sunday attempt or a renamed column is the caller's to resolve.
    return bad(e instanceof Error ? e.message : String(e), 409);
  }
}
