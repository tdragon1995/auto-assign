import { NextResponse } from "next/server";
import { fetchSheetRowsByName, SHEET_CONTRACT } from "@/lib/sheets";

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

// Held until the day turns or ?fresh=1 asks, not on a timer — the same discipline as the
// mapping config. This sheet is edited weekly and was being downloaded on EVERY chấm-công
// page open, which is the most extreme version of paying repeatedly for something that
// does not change. Per-instance and in-memory: a warm instance answers with no network at
// all. Ops editing the schedule mid-day should hit ?fresh=1 (the page's reload path).
let cached: { day: string; body: ScheduleResponse } | null = null;

interface ScheduleResponse {
  morning: ScheduleEntry[];
  afternoon: ScheduleEntry[];
  dateLabel: string;
}

function vnToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()).slice(0, 10);
}

export async function GET(req: Request) {
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const today = vnToday();
  if (!fresh && cached && cached.day === today) return NextResponse.json(cached.body);

  try {
    // The contract matters more here than anywhere else: this endpoint looks the
    // tab up by its VISIBLE NAME, and Google answers an unknown name with the
    // first tab in the workbook instead of an error — which is the ~1,700-row
    // customer→driver mapping. Renaming this tab therefore used to read as
    // perfectly good data about something else entirely.
    const rows = await fetchSheetRowsByName(SHEET_NAME, SHEET_CONTRACT.public_sunday);

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

    const body: ScheduleResponse = { morning, afternoon, dateLabel };
    // Never cache an empty schedule for the rest of the day. The cache is held
    // until the date turns, so one bad read used to blank the driver-facing
    // schedule until midnight with no way back short of ?fresh=1 — and nobody
    // knows to ask for that.
    if (morning.length > 0 || afternoon.length > 0) cached = { day: today, body };
    return NextResponse.json(body);
  } catch (e) {
    // Serve a good earlier copy rather than an error screen — the schedule is display-only
    // and yesterday's answer beats none while the sheet is briefly unreachable.
    if (cached) return NextResponse.json(cached.body);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
