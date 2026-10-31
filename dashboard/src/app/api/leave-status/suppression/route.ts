import { NextRequest, NextResponse } from "next/server";
import { LeaveWriteError } from "@/lib/leave-rows";
import { removeMasterLeaveSuppression } from "@/lib/leave-suppression";
import { invalidateLeaveCache } from "@/lib/leave-config";
import { THAY_CA_LABEL } from "@/lib/thay-ca";
import { reconcileThayCa } from "@/lib/thay-ca-reconcile";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

/**
 * DELETE — drop one line from the deleted-days list, so the MISA sync may
 * write that day again. Body: { driver_id, leave_from, timeLabel }.
 *
 * The undo half of the delete button, and the reason the suppression list is
 * safe to have at all. A suppression is a standing instruction to ignore what
 * MISA says about one day; the failure mode of any such list is that it outlives
 * the reason for it and nobody remembers it is there. So it is shown in the
 * panel while it can still block anything, and removing it is one click rather
 * than a trip into the database.
 *
 * Restoring an ordinary leave lifts the MISA bar. Restoring a generated Thay ca
 * suppression reconciles immediately so the operational row can return.
 */
export async function DELETE(req: NextRequest) {
  const bad = (msg: string) => NextResponse.json({ ok: false, error: msg }, { status: 400 });
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return bad("Body không hợp lệ");
    const { driver_id, leave_from, timeLabel } = body as {
      driver_id?: string;
      leave_from?: string;
      timeLabel?: string | null;
    };
    if (!driver_id || !leave_from) return bad("Thiếu driver_id / leave_from");

    const result = await removeMasterLeaveSuppression({
      driver_id,
      leave_from,
      timeLabel: timeLabel ?? null,
    });
    let thayCa = null;
    let warning = null;
    if (result.loai_nghi === THAY_CA_LABEL) {
      try {
        await invalidateLeaveCache();
        thayCa = await reconcileThayCa();
      } catch (error) {
        console.error("[leave-status] Thay ca reconciliation after restore failed", error);
        warning = `Đã bỏ chặn nhưng chưa tạo lại dòng ${THAY_CA_LABEL}: ${String(error)}`;
      }
    }
    return NextResponse.json({
      ok: true,
      row: result.row,
      loai_nghi: result.loai_nghi,
      thayCa,
      warning,
    });
  } catch (e) {
    if (e instanceof LeaveWriteError) return bad(e.message);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
