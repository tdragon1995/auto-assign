import { NextRequest, NextResponse } from "next/server";
import { appendNghiPhep } from "@/lib/sheets-writer";
import { vnTimestamp } from "@/lib/time";

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

    // Columns: Timestamp | Driver ID | Tên nhân viên | Loại nghỉ | Ngày bắt đầu | Ngày kết thúc | Giờ bắt đầu | Giờ kết thúc
    const row: (string | null)[] = [
      vnTimestamp(),
      driver_id,
      driver_name,
      loaiNghiText,
      ngay_bat_dau,
      ngay_ket_thuc ?? null,
      gio_bat_dau ?? null,
      gio_ket_thuc ?? null,
    ];

    await appendNghiPhep(row);

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[nghi-phep]", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
