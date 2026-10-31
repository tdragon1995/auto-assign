import { NextResponse } from "next/server";
import { sbSelectAll } from "@/lib/supabase-rest";
import { loadSundayLines } from "@/lib/sunday-roster-zalo";
import { displayArea, displayShift, isMorning, isOpen, isPublished } from "@/lib/sunday-roster-post";

/** The roster ops edit in Lịch Chủ nhật: the next saved Sunday from today on,
 *  else the latest one before. Lines carry their id and whether they are open,
 *  so the tab's "Nhận ca" button claims exactly the line the driver sees. */
async function masterSchedule(today: string): Promise<ScheduleResponse> {
  const dates = (await sbSelectAll<{ work_date: string }>("master_sunday_roster", "select=work_date&work_date=not.is.null", "work_date.desc")).map((d) => d.work_date);
  const date = [...dates].reverse().find((d) => d >= today) ?? dates[0];
  const out: ScheduleResponse = { morning: [], afternoon: [], dateLabel: "" };
  if (!date) return out;
  out.dateLabel = `${date.slice(8)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
  out.date = date;
  // Past Sundays are shown, never claimable.
  const claimable = date >= today;
  for (const l of await loadSundayLines(date)) {
    if (!isPublished(l.area)) continue;
    const open = isOpen(l);
    const entry: ScheduleEntry = {
      stt: "", name: l.away ? "" : l.name, addr: displayArea(l.area), ca: displayShift(l.shift), note: l.note, phone: l.phone,
      id: l.id, open, ...(l.away ? { away: true } : {}), ...(claimable && open ? { claimable: true } : {}),
    };
    (isMorning(l.shift) ? out.morning : out.afternoon).push(entry);
  }
  out.morning.forEach((e, i) => (e.stt = String(i + 1)));
  out.afternoon.forEach((e, i) => (e.stt = String(i + 1)));
  return out;
}

interface ScheduleEntry {
  stt: string;
  name: string;
  addr: string;
  ca: string;
  note: string;
  phone: string;
  /** The roster line, whether it still needs someone, whether
   *  that is because its driver is away, and whether it can still be claimed. */
  id?: number;
  open?: boolean;
  away?: boolean;
  claimable?: boolean;
}

// Per-instance and in-memory, held for a minute: the read is two cheap Supabase
// queries and claims change it, so a driver must not see a slot as open long
// after someone took it. ?fresh=1 skips it.
let cached: { day: string; at: number; body: ScheduleResponse } | null = null;
const MASTER_TTL_MS = 60_000;

interface ScheduleResponse {
  morning: ScheduleEntry[];
  afternoon: ScheduleEntry[];
  dateLabel: string;
  date?: string;
}

function vnToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()).slice(0, 10);
}

export async function GET(req: Request) {
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const today = vnToday();
  if (!fresh && cached && cached.day === today && Date.now() - cached.at < MASTER_TTL_MS) return NextResponse.json(cached.body);

  try {
    const body = await masterSchedule(today);
    const { morning, afternoon } = body;
    // Never cache an empty schedule for the rest of the day. The cache is held
    // until the date turns, so one bad read used to blank the driver-facing
    // schedule until midnight with no way back short of ?fresh=1 — and nobody
    // knows to ask for that.
    if (morning.length > 0 || afternoon.length > 0) cached = { day: today, at: Date.now(), body };
    return NextResponse.json(body);
  } catch (e) {
    // Serve a good earlier copy rather than an error screen — the schedule is display-only
    // and yesterday's answer beats none while Supabase is briefly unreachable.
    if (cached) return NextResponse.json(cached.body);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
