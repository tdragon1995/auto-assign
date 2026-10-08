/**
 * "Cập nhật công" — the rules for a correction request, shared by the driver's
 * submit route and the supervisor's, and pinned by scripts/pay.test.mts §9.
 * Pure: no server imports.
 *
 * Two reasons a driver can give:
 *   forgot_tap   — "Quên / chưa biết chấm công". Proof optional: the day's own
 *                  completed stops are the evidence (we keep no GPS trail — only
 *                  each stop's time and place), and the review screen sets the
 *                  requested hours against them.
 *   system_error — "Lỗi hệ thống". A screenshot is REQUIRED.
 * A supervisor's direct correction carries reason 'supervisor'.
 */
import { payrollPeriod } from "./pay-period";
import { addDays } from "./time";

export type DriverReason = "forgot_tap" | "system_error";
export const REASON_LABEL: Record<DriverReason | "supervisor", string> = {
  forgot_tap: "Quên / chưa biết chấm công",
  system_error: "Lỗi hệ thống",
  supervisor: "Quản lý điều chỉnh",
};

/** Proof files: images or a PDF, at most 3, small enough together to stay well
 *  under Vercel's 4.5 MB request body (the form shrinks photos before sending). */
export const MAX_PROOF_FILES = 3;
export const MAX_PROOF_BYTES = 3_000_000;
const DATA_URL = /^data:(image\/(png|jpe?g|webp|gif|heic)|application\/pdf);base64,[A-Za-z0-9+/=]+$/;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The days still open for correction. Payroll runs on the 25th for the period
 * ending on the 14th, so from the 15th to the 25th the PREVIOUS period is still
 * open as well; otherwise only the running one. Never today or later — a day is
 * corrected once it is over.
 */
export function openRange(today: string): { from: string; to: string } {
  const day = Number(today.slice(8, 10));
  const thisMonth = today.slice(0, 7);
  const next = new Date(`${thisMonth}-01T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const running = day <= 14 ? thisMonth : next.toISOString().slice(0, 7);
  const from = day >= 15 && day <= 25 ? payrollPeriod(thisMonth).from : payrollPeriod(running).from;
  return { from, to: addDays(today, -1) };
}

export interface CorrectionInput {
  date: string;
  in_time: string;
  out_time: string;
  note: string;
}

/** Shared checks; returns a Vietnamese message for the person, or null. */
export function checkTimes(c: Partial<CorrectionInput>, today: string, opts: { anyPastDay?: boolean } = {}): string | null {
  if (typeof c.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.date)) return "Ngày không hợp lệ.";
  const { from, to } = openRange(today);
  if (c.date > to) return "Chỉ cập nhật được ngày đã qua.";
  // A supervisor may correct any past day the data still holds; a driver only
  // the open period(s), so a closed payroll is never reopened from a phone.
  if (!opts.anyPastDay && c.date < from) return `Chỉ cập nhật được từ ngày ${from.split("-").reverse().join("/")}.`;
  if (typeof c.in_time !== "string" || !HHMM.test(c.in_time)) return "Giờ vào không hợp lệ.";
  if (typeof c.out_time !== "string" || !HHMM.test(c.out_time)) return "Giờ ra không hợp lệ.";
  if (c.out_time <= c.in_time) return "Giờ ra phải sau giờ vào.";
  if (typeof c.note !== "string" || c.note.length > 500) return "Ghi chú tối đa 500 ký tự.";
  return null;
}

export function checkProof(reason: unknown, files: unknown): string | null {
  if (reason !== "forgot_tap" && reason !== "system_error") return "Chọn lý do.";
  const list = Array.isArray(files) ? files : [];
  if (list.length > MAX_PROOF_FILES) return `Tối đa ${MAX_PROOF_FILES} ảnh.`;
  let bytes = 0;
  for (const f of list) {
    if (!f || typeof f !== "object") return "Tệp không hợp lệ.";
    const { name, dataUrl } = f as { name?: unknown; dataUrl?: unknown };
    if (typeof name !== "string" || name.length > 120 || typeof dataUrl !== "string" || !DATA_URL.test(dataUrl)) {
      return "Chỉ nhận ảnh hoặc PDF.";
    }
    bytes += Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);
  }
  if (bytes > MAX_PROOF_BYTES) return "Ảnh quá lớn — tối đa 3 MB tổng cộng.";
  if (reason === "system_error" && list.length === 0) return "Lỗi hệ thống cần ảnh chụp màn hình lỗi.";
  return null;
}
