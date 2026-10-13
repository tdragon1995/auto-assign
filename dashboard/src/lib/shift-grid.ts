/**
 * Bảng ca — one pay period, every driver, plan against what happened, readable
 * without opening a cell (MISA's Bảng chấm công is the model). Pure: the route
 * gathers the facts, this decides what a cell SAYS.
 */
import type { ShiftWindow } from "./pay";

export type CellStatus = "ok" | "short" | "noshift" | "absent" | "leave" | "off" | "approved" | "";

export const STATUS_LABEL: Record<Exclude<CellStatus, "">, string> = {
  ok: "Đủ công",
  short: "Thiếu công",
  noshift: "Không ca",
  absent: "Chưa chấm công",
  leave: "Nghỉ phép",
  off: "Nghỉ",
  approved: "Đã duyệt",
};

/**
 * Staff codes Bảng ca leaves out (supervisor, 2026-10-13): full-timers who drive
 * but never tap chấm công, so every day of theirs would read as a fault.
 * Hand-kept, like BO_RUNNERS.
 */
export const GRID_IGNORED_CODES = new Set(["DC100043", "DC100993", "DC102121"]);

const min = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** Arriving or leaving within this many minutes of the shift edge still counts as đủ. */
export const GRACE_MIN = 15;

/**
 * What one driver-day says. `actualIn/Out` are VN "HH:MM" (first check-in or first
 * pickup → later of last check-out and last trip); `past` = the day is over.
 */
export function cellStatus(f: {
  plan: ShiftWindow[]; actualIn: string | null; actualOut: string | null;
  wholeDayLeave: boolean; dayOff: boolean; approved: boolean; past: boolean;
}): CellStatus {
  if (f.approved) return "approved";
  const worked = !!f.actualIn;
  if (f.wholeDayLeave && !worked) return "leave";
  if (!f.plan.length) return worked ? "noshift" : f.dayOff ? "off" : "";
  if (!worked) return f.past ? "absent" : "";
  const first = f.plan[0], last = f.plan[f.plan.length - 1];
  const lateIn = min(f.actualIn!) > min(first.start) + GRACE_MIN;
  const earlyOut = !f.actualOut || min(f.actualOut) < min(last.end) - GRACE_MIN;
  return lateIn || earlyOut ? "short" : "ok";
}

/** The pay period a date falls in, named like Lương PT: 15/09–14/10 is "2026-10". */
export function periodMonthOf(date: string): string {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  if (Number(date.slice(8, 10)) >= 15) d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 7);
}
