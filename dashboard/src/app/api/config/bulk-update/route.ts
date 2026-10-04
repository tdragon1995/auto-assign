import { resolveConfigDay } from "@/lib/config-day";
import { NextRequest, NextResponse } from "next/server";
import { bulkUpdateConfigRows } from "@/lib/sheets-writer";
import { splitDriverNames, DRIVER_SEP } from "@/lib/driver-cell";
import { loadDriversFromSheet, invalidateConfigCache } from "@/lib/config";
import { parseConfigTargets } from "@/lib/config-targets";

export const preferredRegion = "sin1";

/**
 * The Config tab's bulk "Đổi tài xế" / "Đổi ca": one driver cell or one window
 * written onto every ticked row, in one Sheets write.
 *
 * It replaces a loop of complete-row calls that ran out of Google's per-minute
 * read quota after ~25 rows (see bulkUpdateConfigRows). The checks are
 * complete-row's: every name on the roster and a valid resulting window.
 * Omitted or blank boundaries keep each row's current time. The cache is bumped once.
 */
export async function POST(req: NextRequest) {
  const started = performance.now();
  const bad = (msg: string, code = 400) => NextResponse.json({ ok: false, error: msg }, { status: code });
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return bad("Body không hợp lệ");
    const configDay = resolveConfigDay(body.config_day);
    const { rows, driver_name, shift_start, shift_end } = body as {
      rows?: unknown; driver_name?: string; shift_start?: string; shift_end?: string;
    };
    const parsed = parseConfigTargets(rows);
    if ("error" in parsed) return bad(parsed.error);

    if ([shift_start, shift_end].some(t => t !== undefined && typeof t !== "string")) return bad("Giờ không hợp lệ");
    const start = (shift_start ?? "").trim(), end = (shift_end ?? "").trim();
    if ([start, end].some(t => t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) return bad(`Khung giờ không hợp lệ: ${start}–${end}`);
    if (start && end && start === end) return bad("Giờ bắt đầu và kết thúc trùng nhau — dòng sẽ không bao giờ trực");

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
    if (driverName === undefined && !start && !end) return bad("Không có gì để ghi");

    const result = await bulkUpdateConfigRows({ config_day: configDay,
      targets: parsed.targets,
      driverName,
      start: start || undefined,
      end: end || undefined,
    });
    if (result.done.length > 0) await invalidateConfigCache();
    return NextResponse.json({ ok: true, ...result }, {headers:{"Server-Timing":`total;dur=${Math.round(performance.now()-started)}`}});
  } catch (e) {
    // A Sunday attempt or a renamed column is the caller's to resolve.
    return bad(e instanceof Error ? e.message : String(e), 409);
  }
}
