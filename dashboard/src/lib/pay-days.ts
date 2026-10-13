/**
 * The two per-day inputs the hours rule needs besides taps and trips, loaded ONE
 * way for every reader (Lương PT, Thu Nhập, the correction review):
 *
 *   shifts      — a driver's working windows for the day, from three places:
 *                 · Lịch ca tài xế (driver_shifts);
 *                 · Lịch Chủ nhật (master_sunday_roster) — Sunday rosters live there,
 *                   not in Lịch ca, so without it every Sunday read "Không ca";
 *                 · covering someone's leave (a named substitute on Nghỉ phép): the
 *                   substitute's hours, else the leave's, else — a whole day — the
 *                   absent driver's own shift that day.
 *                 Overlaps merge (mergeWindows), so no minute is paid twice.
 *                 Once payroll's file is in for a period (source 'payroll'), ONLY
 *                 payroll's and hand-entered ('manual') rows count and the other two
 *                 sources are ignored: the file is that period's whole truth (Lưu Minh
 *                 12/09: an old 17:00–20:00 row paid 3 h payroll never did).
 *   corrections — APPROVED "cập nhật công"; the newest approved one per day wins.
 *
 * Keyed `${driver_id}|${YYYY-MM-DD}`. SERVER ONLY.
 */
import { sbSelect, sbSelectAll } from "./supabase-rest";
import { mergeWindows, parseShiftText, type ShiftWindow } from "./pay";
import { addDays } from "./time";

export const dayKey = (driverId: string, date: string) => `${driverId}|${date}`;
const hm = (t: string | null) => (t ?? "").slice(0, 5);

export interface CorrectionRow {
  id: number;
  driver_id: string;
  driver_name: string | null;
  trip_date: string;
  in_time: string;
  out_time: string;
  reason: "forgot_tap" | "system_error" | "supervisor";
  note: string;
  proof_urls: string[];
  source: "driver" | "supervisor";
  status: "pending" | "approved" | "rejected" | "withdrawn";
  decision_note: string;
  created_at: string;
  decided_at: string | null;
}

interface LeaveRow {
  starts_on: string; ends_on: string; starts_at: string | null; ends_at: string | null;
  linked_driver_id: string | null;
  master_leave_substitutes: { driver_id: string | null; starts_at: string | null; ends_at: string | null; coverage_kind: string | null }[] | null;
}

/** A Lịch Chủ nhật line describing a WEEKDAY role ("BO Runner (Thứ 2 tới 7)") is
 *  repeated on every week's roster; it is not a Sunday shift. */
export const isWeekdayRoleLine = (area: string) => /\(\s*Thứ\s/i.test(area) && !/\bCN\b/.test(area);

export async function loadPayDayInputs(from: string, to: string, driverId?: string) {
  const who = driverId ? `&driver_id=eq.${driverId}` : "&driver_id=not.is.null";
  const [corrections, payrollAny, sunday, leaves] = await Promise.all([
    sbSelectAll<CorrectionRow>(
      "pay_day_corrections",
      `select=*&trip_date=gte.${from}&trip_date=lte.${to}${driverId ? `&driver_id=eq.${driverId}` : ""}`,
      "id.asc",
    ),
    // Imported is a PERIOD fact, not a driver's: a driver payroll left out of the
    // file entirely must still read as "file is in, you have no shift".
    sbSelect<{ shift_date: string }>(
      "driver_shifts",
      `select=shift_date&source=eq.payroll&shift_date=gte.${from}&shift_date=lte.${to}&limit=1`,
    ),
    sbSelectAll<{ driver_id: string; work_date: string; area: string; shift: string | null }>(
      "master_sunday_roster",
      `select=driver_id,work_date,area,shift&work_date=gte.${from}&work_date=lte.${to}${who}`,
      "work_date.asc,sort.asc",
    ),
    sbSelectAll<LeaveRow>(
      "master_leave_read",
      `select=starts_on,ends_on,starts_at,ends_at,linked_driver_id,master_leave_substitutes&active=eq.true&starts_on=lte.${to}&ends_on=gte.${from}` +
        (driverId ? `&master_leave_substitutes=cs.${encodeURIComponent(JSON.stringify([{ driver_id: driverId }]))}` : ""),
      "id.asc",
    ),
  ]);
  const payrollImported = payrollAny.length > 0;

  // A whole-day cover takes the ABSENT driver's shift, so one driver's view also
  // needs the shifts of whoever they covered.
  const takers = [...new Set(leaves.map((l) => l.linked_driver_id).filter((id): id is string => !!id))];
  const shiftWho = driverId ? `&driver_id=in.(${[driverId, ...takers].join(",")})` : who;
  const shiftRows = await sbSelectAll<{ driver_id: string; shift_date: string; start_time: string | null; end_time: string | null; source: string }>(
    "driver_shifts",
    `select=driver_id,shift_date,start_time,end_time,source&day_type=eq.working&shift_date=gte.${from}&shift_date=lte.${to}${shiftWho}`,
    "shift_date.asc,employee_code.asc,slot.asc",
  );

  const shifts = new Map<string, ShiftWindow[]>();
  /** Where a day's shift came from beyond Lịch ca, for the Bảng ca grid: a Sunday
   *  roster line, and whose leave it covers. */
  const origin = new Map<string, { sunday: boolean; covers: string[] }>();
  const mark = (driver: string, date: string, o: { sunday?: boolean; cover?: string }) => {
    const k = dayKey(driver, date), m = origin.get(k) ?? { sunday: false, covers: [] };
    if (o.sunday) m.sunday = true;
    if (o.cover && !m.covers.includes(o.cover)) m.covers.push(o.cover);
    origin.set(k, m);
  };
  const add = (driver: string, date: string, w: ShiftWindow) => {
    const k = dayKey(driver, date);
    const list = shifts.get(k);
    if (list) list.push(w); else shifts.set(k, [w]);
  };
  for (const r of shiftRows) {
    if (!r.start_time || !r.end_time) continue;
    if (payrollImported && r.source !== "payroll" && r.source !== "manual") continue;
    add(r.driver_id, r.shift_date, { start: hm(r.start_time), end: hm(r.end_time) });
  }
  if (!payrollImported) {
    for (const r of sunday) {
      const w = isWeekdayRoleLine(r.area) ? null : parseShiftText(r.shift);
      if (w) { add(r.driver_id, r.work_date, w); mark(r.driver_id, r.work_date, { sunday: true }); }
    }
    const base = new Map([...shifts].map(([k, v]) => [k, [...v]]));
    for (const l of leaves) for (const s of l.master_leave_substitutes ?? []) {
      if (!s.driver_id || (s.coverage_kind && s.coverage_kind !== "driver")) continue;
      if (driverId && s.driver_id !== driverId) continue;
      const own = s.starts_at && s.ends_at ? { start: hm(s.starts_at), end: hm(s.ends_at) }
        : l.starts_at && l.ends_at ? { start: hm(l.starts_at), end: hm(l.ends_at) } : null;
      for (let d = l.starts_on < from ? from : l.starts_on; d <= (l.ends_on > to ? to : l.ends_on); d = addDays(d, 1)) {
        const ws = own ? [own] : l.linked_driver_id ? base.get(dayKey(l.linked_driver_id, d)) ?? [] : [];
        for (const w of ws) add(s.driver_id, d, w);
        if (ws.length && l.linked_driver_id) mark(s.driver_id, d, { cover: l.linked_driver_id });
      }
    }
  }
  for (const [k, v] of shifts) shifts.set(k, mergeWindows(v));

  // Ascending id, so a later approval overwrites an earlier one for the same day.
  const approved = new Map<string, ShiftWindow>();
  /** The latest request of any status per day, for showing its state. */
  const latest = new Map<string, CorrectionRow>();
  for (const c of corrections) {
    const k = dayKey(c.driver_id, c.trip_date);
    latest.set(k, c);
    if (c.status === "approved") approved.set(k, { start: hm(c.in_time), end: hm(c.out_time) });
  }

  return {
    shifts, approved, latest, corrections, origin,
    /** Payroll's file has been written into Lịch ca for this period. */
    payrollImported,
  };
}
