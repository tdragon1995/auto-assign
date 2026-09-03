import { NextRequest, NextResponse } from "next/server";
import { removeLeaveSuppression, LeaveWriteError } from "@/lib/sheets-writer";
import { invalidateSuppressionCache } from "@/lib/leave-suppression";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

/**
 * DELETE — drop one line from the "Nghỉ phép đã xoá" tab, so the MISA sync may
 * write that day again. Body: { driver_id, leave_from, timeLabel }.
 *
 * The undo half of the delete button, and the reason the suppression list is
 * safe to have at all. A suppression is a standing instruction to ignore what
 * MISA says about one day; the failure mode of any such list is that it outlives
 * the reason for it and nobody remembers it is there. So it is shown in the
 * panel while it can still block anything, and removing it is one click rather
 * than a trip into the workbook.
 *
 * Restoring does not re-create the leave row itself — it lifts the bar, and the
 * next sync (04:45 / 12:00 VN) writes the day back if MISA still charges it. If
 * MISA no longer does, nothing comes back, which is the correct answer.
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

    const result = await removeLeaveSuppression({
      driver_id,
      leave_from,
      timeLabel: timeLabel ?? null,
    });
    invalidateSuppressionCache();
    return NextResponse.json({ ok: true, row: result.row });
  } catch (e) {
    if (e instanceof LeaveWriteError) return bad(e.message);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
