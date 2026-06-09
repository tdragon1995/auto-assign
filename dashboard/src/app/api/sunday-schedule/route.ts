import { NextResponse } from "next/server";
import { fetchSheetRowsByName } from "@/lib/sheets";

// Display-only schedule tab maintained weekly by ops. Read by visible name so a
// re-created tab/gid doesn't break us. Columns:
//   Ngày làm việc | STT | Họ và tên | Địa điểm | Ca | Ghi chú | Số điện thoại
const SHEET_NAME = "(Edit weekly) PUBLIC SUNDAY SCHEDULE";

interface ScheduleEntry {
  stt: string;
  name: string;
  addr: string;
  ca: string;
  note: string;
  phone: string;
}

// "dd/MM/yyyy" → sortable yyyymmdd number, or 0 if unparseable.
function dateKey(s: string): number {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return 0;
  const [, d, mo, y] = m;
  return Number(y) * 10000 + Number(mo) * 100 + Number(d);
}

export async function GET() {
  try {
    const rows = await fetchSheetRowsByName(SHEET_NAME);

    // The sheet may carry several weeks; only the latest work date is "live".
    let latestKey = 0;
    for (const r of rows) {
      const k = dateKey(r["Ngày làm việc"] ?? "");
      if (k > latestKey) latestKey = k;
    }
    const dateLabel =
      rows.find((r) => dateKey(r["Ngày làm việc"] ?? "") === latestKey)?.["Ngày làm việc"]?.trim() ?? "";

    const morning: ScheduleEntry[] = [];
    const afternoon: ScheduleEntry[] = [];

    for (const r of rows) {
      if (latestKey && dateKey(r["Ngày làm việc"] ?? "") !== latestKey) continue;

      const stt   = (r["STT"] ?? "").trim();
      const name  = (r["Họ và tên"] ?? "").trim();
      const addr  = (r["Địa điểm"] ?? "").trim();
      const ca    = (r["Ca"] ?? "").trim();
      const note  = (r["Ghi chú"] ?? "").trim();
      const phone = (r["Số điện thoại"] ?? "").trim();

      // Drop fully blank rows.
      if (!stt && !name && !addr && !ca && !note) continue;

      // Internal-only roles aren't part of the published driver schedule.
      if (addr.includes("BO Runner") || addr.includes("Logistics General")) continue;

      // Strip the leading PT/DC payroll code from the name (e.g. "PT101225 Đoàn Văn Thảo").
      const cleanName = name.replace(/^(PT|DC)\d+\s+/i, "");

      // Shift split mirrors the Apps Script: start hour < 15 → morning, else afternoon.
      const startHour = parseInt((ca.match(/(\d{1,2})[:.]/) ?? ["", "0"])[1], 10);

      const entry: ScheduleEntry = { stt, name: cleanName, addr, ca, note, phone };
      if (startHour < 15) morning.push(entry);
      else afternoon.push(entry);
    }

    return NextResponse.json({ morning, afternoon, dateLabel });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
