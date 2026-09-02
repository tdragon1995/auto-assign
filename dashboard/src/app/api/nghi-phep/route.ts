import { NextRequest, NextResponse } from "next/server";
import { appendNghiPhep } from "@/lib/sheets-writer";
import { vnTimestamp } from "@/lib/time";
import { sendZaloMessage } from "@/lib/zalo";
import {
  loadLeaveEntriesStrict,
  LeaveUnreadableError,
  invalidateLeaveCache,
  findLeaveConflict,
  type LeaveEntry,
  type InvalidLeaveRow,
} from "@/lib/leave-config";
import { loadLeaveSuppressions, findSuppression } from "@/lib/leave-suppression";

/** Short human label for a clashing existing leave, for the reject message. */
function describeLeave(e: LeaveEntry): string {
  const dm = (s: string) => (s.length >= 10 ? `${s.slice(8, 10)}/${s.slice(5, 7)}` : s);
  const to = e.leave_to && e.leave_to !== e.leave_from ? `–${dm(e.leave_to)}` : "";
  const hrs = e.gio_bat_dau && e.gio_ket_thuc ? ` (${e.gio_bat_dau}–${e.gio_ket_thuc})` : "";
  return `${e.loai_nghi || "Nghỉ"} ${dm(e.leave_from)}${to}${hrs}`;
}

function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const end = new Date(to + "T00:00:00");
  const cur = new Date(from + "T00:00:00");
  while (cur <= end) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, "0");
    const d = String(cur.getDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// Fire-and-forget notification to the admin Zalo group. The leave is already
// saved to the sheet, so a Zalo failure must never fail the request. The text is
// the same template the cham-cong page shows the driver to copy/share.
async function notifyAdminGroup(text: string): Promise<void> {
  if (!text) return;
  const botToken = process.env.ZALO_ADMIN_BOT_TOKEN;
  const chatId = process.env.ZALO_ADMIN_CHAT_ID;
  if (!botToken || !chatId) return;
  try {
    await sendZaloMessage(botToken, chatId, text);
  } catch (e) {
    console.error("[nghi-phep] admin Zalo notify failed", e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      driver_id, driver_name, loai_nghi, ngay_bat_dau, ngay_ket_thuc,
      gio_bat_dau, gio_ket_thuc, notify_message, note, automated,
    } = body;

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

    const ts = vnTimestamp();

    // Optional provenance marker written to the sheet's `note` column (N), used
    // by the MISA shift sync to mark rows it created automatically so a
    // supervisor can tell them from hand-typed ones. Rows stay 8 wide when no
    // note is given, exactly as before. The columns in between (I `day`,
    // K `sub1_id`) are formulas that appendNghiPhep re-fills after the append,
    // so writing blanks through them is safe.
    const NOTE_COL_INDEX = 13; // A=0 … N=13
    const withNote = (row: (string | null)[]): (string | null)[] => {
      if (typeof note !== "string" || !note.trim()) return row;
      const padded = [...row];
      while (padded.length < NOTE_COL_INDEX) padded.push(null);
      padded[NOTE_COL_INDEX] = note.trim();
      return padded;
    };

    let rows: (string | null)[][];
    // Candidate leave (same shape as a sheet row) used for the duplicate check.
    let candidate: LeaveEntry;

    if (loai_nghi === "nguyen_buoi") {
      // One row per day in the range — all written in one atomic API call
      const days = datesBetween(ngay_bat_dau, ngay_ket_thuc ?? ngay_bat_dau);
      rows = days.map((day) => withNote([ts, driver_id, driver_name, loaiNghiText, day, day, null, null]));
      candidate = {
        driver_id, driver_name, loai_nghi: loaiNghiText,
        leave_from: ngay_bat_dau, leave_to: ngay_ket_thuc ?? ngay_bat_dau,
        gio_bat_dau: null, gio_ket_thuc: null, subs: [],
      };
    } else if (loai_nghi === "nua_buoi") {
      // leave_to = leave_from (same day)
      rows = [withNote([ts, driver_id, driver_name, loaiNghiText, ngay_bat_dau, ngay_bat_dau, gio_bat_dau ?? null, gio_ket_thuc ?? null])];
      candidate = {
        driver_id, driver_name, loai_nghi: loaiNghiText,
        leave_from: ngay_bat_dau, leave_to: ngay_bat_dau,
        gio_bat_dau: gio_bat_dau ?? null, gio_ket_thuc: gio_ket_thuc ?? null, subs: [],
      };
    } else {
      // nghi_viec — store leave_from as last_working_day + 1 so the engine
      // skips the driver starting from the day AFTER their last working day
      const lastDay = new Date(ngay_bat_dau + "T00:00:00");
      lastDay.setDate(lastDay.getDate() + 1);
      const skipFrom = [
        lastDay.getFullYear(),
        String(lastDay.getMonth() + 1).padStart(2, "0"),
        String(lastDay.getDate()).padStart(2, "0"),
      ].join("-");
      rows = [withNote([ts, driver_id, driver_name, loaiNghiText, skipFrom, null, null, null])];
      candidate = {
        driver_id, driver_name, loai_nghi: loaiNghiText,
        leave_from: skipFrom, leave_to: null,
        gio_bat_dau: null, gio_ket_thuc: null, subs: [],
      };
    }

    // Block duplicate/overlapping leave: read the sheet fresh (so a leave
    // submitted minutes ago is seen) and reject if this driver already has a
    // clashing entry. The client's disabled-while-loading submit button handles
    // the rapid double-click; this catches the re-submit-later case that was
    // creating stale duplicate rows.
    //
    // If the sheet cannot be read the write is REFUSED, not waved through. The
    // check used to fail open: it cleared the cache, read, and took the empty
    // list that a failed read returns as "no clash". On 30/08 a renamed column
    // had the tab refused all day, so every one of the MISA sync's 21 runs
    // re-appended the same eight rows — 160 identical rows for one day off. A
    // refusal is recoverable (the caller retries, and the dashboard already
    // names a refused tab); a blind append is not.
    let onSheet: { entries: LeaveEntry[]; invalid: InvalidLeaveRow[] };
    try {
      onSheet = await loadLeaveEntriesStrict();
    } catch (e) {
      if (!(e instanceof LeaveUnreadableError)) throw e;
      console.error("[nghi-phep] refusing to write — leave sheet unreadable");
      return NextResponse.json(
        {
          error: "Chưa đọc được bảng nghỉ phép nên tạm chưa ghi được đơn " +
            "(tránh ghi trùng). Vui lòng thử lại sau ít phút.",
        },
        { status: 503 },
      );
    }
    // A day a supervisor deliberately REMOVED must not be written back by the
    // robot that keeps re-deriving it. This is the check that makes the delete
    // button mean something: the MISA pusher rebuilds every charged day from
    // today forward on each run and dedupes only on the row being present, so
    // without it a partly-approved request is un-deleted at 04:45.
    //
    // Automated callers only, and that scoping is the safety property rather
    // than an optimisation. A person filing leave — the driver's own form, a
    // supervisor in the panel — is NEVER blocked by a suppression, so a stale
    // one can never be the reason a real day off failed to register, and the way
    // past it is the ordinary action instead of editing the sheet.
    //
    // An unreadable list lets the write through (`trusted`), which is exactly
    // the behaviour before suppressions existed; failing closed here would take
    // out the driver's leave form over a tab that, on a first deploy, correctly
    // does not exist yet.
    const isAutomated =
      automated === true || (typeof note === "string" && /^MISA auto\b/.test(note.trim()));
    if (isAutomated) {
      const { list, trusted } = await loadLeaveSuppressions();
      const blocked = trusted ? findSuppression(candidate, list) : null;
      if (blocked) {
        return NextResponse.json(
          {
            error:
              `Ngày nghỉ này đã được xoá thủ công (${blocked.deleted_at || "không rõ thời điểm"}) ` +
              `nên không tự tạo lại. Nếu cần khôi phục, bỏ dòng tương ứng trong bảng ` +
              `"Nghỉ phép đã xoá" (nút Khôi phục trên dashboard).`,
            suppressed: true,
          },
          { status: 409 },
        );
      }
    }

    const clash = findLeaveConflict(candidate, onSheet.entries, onSheet.invalid);
    if (clash) {
      return NextResponse.json(
        {
          error: `Tài xế đã có lịch nghỉ trùng: ${describeLeave(clash)}. ` +
            `Nếu cần chỉnh sửa, vui lòng liên hệ đội điều phối.`,
        },
        { status: 409 },
      );
    }

    await appendNghiPhep(rows);
    // The append changed the sheet — drop the cache we just refreshed so the
    // next read (dashboard panel / next submission) sees this new row.
    await invalidateLeaveCache();

    // Relay the same template the driver sees to the admin Zalo group.
    await notifyAdminGroup(typeof notify_message === "string" ? notify_message : "");

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[nghi-phep]", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
