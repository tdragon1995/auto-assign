import { NextRequest, NextResponse } from "next/server";
import { appendNghiPhep } from "@/lib/sheets-writer";
import { vnTimestamp } from "@/lib/time";
import { sendZaloMessage } from "@/lib/zalo";
import {
  loadLeaveEntries,
  invalidateLeaveCache,
  findLeaveConflict,
  type LeaveEntry,
} from "@/lib/leave-config";

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
    const { driver_id, driver_name, loai_nghi, ngay_bat_dau, ngay_ket_thuc, gio_bat_dau, gio_ket_thuc, notify_message, note } = body;

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

    // Block duplicate/overlapping leave: read the sheet fresh (bust the 5-min
    // cache so a leave submitted minutes ago is seen) and reject if this driver
    // already has a clashing entry. The client's disabled-while-loading submit
    // button handles the rapid double-click; this catches the re-submit-later
    // case that was creating stale duplicate rows.
    await invalidateLeaveCache();
    const existing = await loadLeaveEntries();
    const clash = findLeaveConflict(candidate, existing);
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
