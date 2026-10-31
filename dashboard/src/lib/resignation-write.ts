/**
 * The writes behind a resignation's per-date cover and its ending. See the
 * RESIGNATIONS note in `leave-config.ts` for the rules.
 */
import { RESIGN_COVER_NOTE, isResignCover } from "./leave-config";
import { normDate, type LeaveCells } from "./leave-rows";
import {
  appendMasterLeave, deleteMasterLeaves, masterLeaveRecords, updateMasterLeave, type LeaveRecordRow,
} from "./master-leave";
import { addDays, vnTimestamp } from "./time";

const v = (r: LeaveRecordRow, k: string) => (r.values[k] ?? "").trim();
const isCoverRow = (r: LeaveRecordRow) => isResignCover({ loai_nghi: v(r, "Loại Nghỉ"), note: v(r, "note") });

/** The whole-day row that holds `date`'s cover for a resigned driver, created
 *  the first time anyone is named for that date. */
export async function ensureResignCover(driverId: string, driverName: string, date: string): Promise<void> {
  const rows = await masterLeaveRecords();
  if (rows.some((r) => v(r, "driver_id") === driverId && isCoverRow(r) && normDate(v(r, "leave_from")) === date)) return;
  await appendMasterLeave([{
    submitted_at: vnTimestamp(), driver_name: driverName, loai_nghi: "Nghỉ nguyên buổi",
    leave_from: date, leave_to: date, note: RESIGN_COVER_NOTE,
  }]);
}

/** `driverId` works on `date`, so a resignation covering it is over: it ends
 *  the day before, or goes altogether when it started that day. Their covers
 *  from `date` on go with it. Returns the driver's label when one ended. */
export async function endResignationOn(driverId: string, date: string): Promise<string | null> {
  const rows = await masterLeaveRecords();
  const open = rows.filter((r) => {
    if (v(r, "driver_id") !== driverId || v(r, "Loại Nghỉ") !== "Nghỉ việc") return false;
    const from = normDate(v(r, "leave_from")), to = normDate(v(r, "leave_to"));
    return from <= date && (!to || date <= to);
  });
  if (!open.length) return null;
  const gone: LeaveRecordRow[] = [];
  for (const r of open) {
    if (normDate(v(r, "leave_from")) >= date) { gone.push(r); continue; }
    const cells: LeaveCells = {
      submitted_at: v(r, "Ngày Nộp Đơn"), driver_name: v(r, "driver"), loai_nghi: "Nghỉ việc",
      leave_from: normDate(v(r, "leave_from")), leave_to: addDays(date, -1),
      leave_from_hr: v(r, "leave_from_hr") || null, leave_to_hr: v(r, "leave_to_hr") || null, note: v(r, "note") || null,
    };
    await updateMasterLeave(r.row, cells, r.revision);
  }
  await dropRows(rows, [...gone, ...coversFrom(rows, driverId, date)]);
  return v(open[0], "driver") || driverId;
}

/** A resignation was deleted: its covers would otherwise linger in the table. */
export async function dropResignCovers(driverId: string, fromDate: string): Promise<void> {
  const rows = await masterLeaveRecords();
  await dropRows(rows, coversFrom(rows, driverId, fromDate));
}

function coversFrom(rows: LeaveRecordRow[], driverId: string, fromDate: string) {
  return rows.filter((r) => v(r, "driver_id") === driverId && isCoverRow(r) && normDate(v(r, "leave_from")) >= fromDate);
}

async function dropRows(all: LeaveRecordRow[], victims: LeaveRecordRow[]) {
  if (!victims.length) return;
  await deleteMasterLeaves(victims.map((r) => r.row), new Map(all.map((r) => [r.row, r.revision ?? 0])));
}
