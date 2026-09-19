import { NextResponse } from "next/server";
import { fetchSheetRowsByName, SHEET_CONTRACT } from "@/lib/sheets";
import { leaveEntriesOnDate, loadLeaveEntries } from "@/lib/leave-config";
import { loadDriversFromSheet } from "@/lib/config";
import { leaveFlagFor, sundayDateToIso, type SundayLeaveFlag } from "@/lib/sunday-leave";

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
  /** The name exactly as the tab types it, staff code included. `name` is the
   *  display form with that code stripped; the code is what survives a rename,
   *  so the matcher wants this one. */
  rawName: string;
  /** Set when the leave sheet disagrees with this row — see `sunday-leave.ts`.
   *  Absent on the ordinary row, so a reader can treat presence as the signal. */
  leave?: SundayLeaveFlag;
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
//
// What is cached is the ROSTER AS TYPED — never the leave cross-check laid over
// it. Leave is filed during the day, by MISA and by the panel; freezing a
// morning's answer until midnight would show a driver as fine hours after they
// were marked off, and this feature exists precisely to stop that. The flags are
// therefore recomputed on every request, off two loaders that are themselves
// cached (leave: 5 min, shared; roster: 5 min) — so it costs no sheet download.
let cached: { day: string; body: ScheduleResponse } | null = null;

interface ScheduleResponse {
  morning: ScheduleEntry[];
  afternoon: ScheduleEntry[];
  dateLabel: string;
  /** The rostered date as YYYY-MM-DD, or null when the tab's date cell could
   *  not be read. Null is what turns the leave cross-check OFF for the day: a
   *  leave lookup against a guessed date answers "nobody is off" with total
   *  confidence, which is the one wrong answer this must never give. */
  date?: string | null;
  /** How many rostered rows the leave sheet contradicts, and how many names it
   *  could not tie to an account. Counted server-side so the dashboard can show
   *  the number without re-deriving the rule. */
  conflicts?: { leave: number; unmatched: number };
}

function vnToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()).slice(0, 10);
}

/**
 * The roster with the leave sheet laid over it.
 *
 * Read-only and additive: every row comes back exactly as the tab types it,
 * plus a `leave` flag where the leave module disagrees. Nothing here edits the
 * roster — a rostered row carries a location and a shift only ops can
 * reassign — so the output is a prompt to go and fix the tab, not a fix.
 *
 * It FAILS SOFT, deliberately. If leave or the roster cannot be read we return
 * the schedule unflagged rather than an error: this endpoint's first job is
 * showing drivers where to be on Sunday, and an unreachable leave sheet must
 * not take that offline. The absence of flags then means "not checked", which
 * is the same thing it meant before this existed.
 */
async function withLeave(body: ScheduleResponse, fresh = false): Promise<ScheduleResponse> {
  const date = body.date ?? null;
  if (!date) return body;
  try {
    const [entries, roster] = await Promise.all([
      loadLeaveEntries(fresh),
      loadDriversFromSheet(),
    ]);
    const onDate = leaveEntriesOnDate(date, entries);
    let leaveCount = 0;
    let unmatched = 0;
    const flag = (rows: ScheduleEntry[]): ScheduleEntry[] =>
      rows.map((r) => {
        // Matched on the sheet's own cell, staff code and all — `name` here has
        // already had the PT/DC prefix stripped for display, and that prefix is
        // the one part of a label that survives a rename, so the code is put
        // back from the row it came from rather than matched on the bare name.
        const f = leaveFlagFor(r.rawName || r.name, r.ca, roster, onDate);
        if (!f) return r;
        if (f.status === "leave") leaveCount++;
        else unmatched++;
        return { ...r, leave: f };
      });
    const morning = flag(body.morning);
    const afternoon = flag(body.afternoon);
    return { ...body, morning, afternoon, conflicts: { leave: leaveCount, unmatched } };
  } catch (e) {
    console.error("Sunday schedule leave cross-check failed:", e);
    return body;
  }
}

export async function GET(req: Request) {
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const today = vnToday();
  if (!fresh && cached && cached.day === today) {
    return NextResponse.json(await withLeave(cached.body));
  }

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

      const entry: ScheduleEntry = { stt, name: cleanName, rawName: name, addr, ca, note, phone };
      if (startHour < 15) morning.push(entry);
      else afternoon.push(entry);
    }

    const body: ScheduleResponse = { morning, afternoon, dateLabel, date: sundayDateToIso(dateLabel) };
    // Never cache an empty schedule for the rest of the day. The cache is held
    // until the date turns, so one bad read used to blank the driver-facing
    // schedule until midnight with no way back short of ?fresh=1 — and nobody
    // knows to ask for that.
    if (morning.length > 0 || afternoon.length > 0) cached = { day: today, body };
    return NextResponse.json(await withLeave(body, fresh));
  } catch (e) {
    // Serve a good earlier copy rather than an error screen — the schedule is display-only
    // and yesterday's answer beats none while the sheet is briefly unreachable.
    if (cached) return NextResponse.json(await withLeave(cached.body));
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
