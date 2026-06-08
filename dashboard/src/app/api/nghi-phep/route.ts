import { NextRequest, NextResponse } from "next/server";
import { appendNghiPhep } from "@/lib/sheets-writer";
import { vnTimestamp } from "@/lib/time";

function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const end = new Date(to + "T00:00:00");
  const cur = new Date(from + "T00:00:00");
  while (cur <= end) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, "0");
    const d = String(cur.getDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { driver_id, driver_name, loai_nghi, ngay_bat_dau, ngay_ket_thuc, gio_bat_dau, gio_ket_thuc } = body;

    if (!driver_id || !driver_name || !loai_nghi || !ngay_bat_dau) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const loaiNghiLabels: Record<string, string> = {
      nguyen_buoi: "Nghỉ nguyên buổi",
      nua_buoi: "Nghỉ nửa buổi",
      nghi_viec: "Nghỉ việc",
    };
    const loaiNghiText = loaiNghiLabels[loai_nghi];
    if (!loaiNghiText) {
      return NextResponse.json({ error: "Invalid loai_nghi" }, { status: 400 });
    }

    const ts = vnTimestamp();
    let rows: (string | null)[][];

    if (loai_nghi === "nguyen_buoi") {
      // One row per day in the range — all written in one atomic API call
      const days = datesBetween(ngay_bat_dau, ngay_ket_thuc ?? ngay_bat_dau);
      rows = days.map((day) => [ts, driver_id, driver_name, loaiNghiText, day, day, null, null]);
    } else if (loai_nghi === "nua_buoi") {
      // leave_to = leave_from (same day)
      rows = [[ts, driver_id, driver_name, loaiNghiText, ngay_bat_dau, ngay_bat_dau, gio_bat_dau ?? null, gio_ket_thuc ?? null]];
    } else {
      // nghi_viec — store leave_from as last_working_day + 1 so the engine
      // skips the driver starting from the day AFTER their last working day
      const lastDay = new Date(ngay_bat_dau + "T00:00:00");
      lastDay.setDate(lastDay.getDate() + 1);
      const skipFrom = [
        lastDay.getFullYear(),
        String(lastDay.getMonth() + 1).padStart(2, "0"),
        String(lastDay.getDate()).padStart(2, "0"),
      ].join("-");
      rows = [[ts, driver_id, driver_name, loaiNghiText, skipFrom, null, null, null]];
    }

    await appendNghiPhep(rows);

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[nghi-phep]", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
