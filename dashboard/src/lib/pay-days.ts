/**
 * The two per-day inputs the hours rule needs besides taps and trips, loaded ONE
 * way for every reader (Lương PT, Thu Nhập, the correction review):
 *
 *   shifts      — working rows of Lịch ca tài xế (driver_shifts). Payroll's monthly
 *                 file is written there for the days it paid (source 'payroll').
 *                 Once it is, ONLY payroll's and hand-entered ('manual') rows count:
 *                 a day payroll did not pay keeps no leftover MISA shift (Lưu Minh
 *                 12/09: an old 17:00–20:00 row paid 3 h payroll never did).
 *   corrections — APPROVED "cập nhật công"; the newest approved one per day wins.
 *
 * Keyed `${driver_id}|${YYYY-MM-DD}`. SERVER ONLY.
 */
import { sbSelect, sbSelectAll } from "./supabase-rest";
import type { ShiftWindow } from "./pay";

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

export async function loadPayDayInputs(from: string, to: string, driverId?: string) {
  const who = driverId ? `&driver_id=eq.${driverId}` : "&driver_id=not.is.null";
  const [shiftRows, corrections, payrollAny] = await Promise.all([
    sbSelectAll<{ driver_id: string; shift_date: string; start_time: string | null; end_time: string | null; source: string }>(
      "driver_shifts",
      `select=driver_id,shift_date,start_time,end_time,source&day_type=eq.working&shift_date=gte.${from}&shift_date=lte.${to}${who}`,
      "shift_date.asc,employee_code.asc,slot.asc",
    ),
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
  ]);
  const payrollImported = payrollAny.length > 0;

  const shifts = new Map<string, ShiftWindow[]>();
  for (const r of shiftRows) {
    if (!r.start_time || !r.end_time) continue;
    if (payrollImported && r.source !== "payroll" && r.source !== "manual") continue;
    const k = dayKey(r.driver_id, r.shift_date);
    const w = { start: hm(r.start_time), end: hm(r.end_time) };
    const list = shifts.get(k);
    if (list) list.push(w); else shifts.set(k, [w]);
  }

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
    shifts, approved, latest, corrections,
    /** Payroll's file has been written into Lịch ca for this period. Before it is,
     *  the shifts are MISA's plan, which matched payroll on only half the days. */
    payrollImported,
  };
}
