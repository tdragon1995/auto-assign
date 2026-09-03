import { NextRequest, NextResponse } from "next/server";
import { clearConfigRow } from "@/lib/sheets-writer";
import { invalidateConfigCache } from "@/lib/config";

/**
 * Empty one config row — the fix for a duplicate rule, where the answer is not
 * "move a boundary" but "this line should not be here".
 *
 * The row is blanked, not deleted: the tab's id columns are a spill anchored in
 * row 2, and every other row's number is being held by the dashboard for its own
 * to-dos. A row with no pickup is one the engine drops and one `writeConfigRows`
 * treats as free space, so blanking is what "removed" already means here.
 *
 * Invalidates the config, so the branch stops clashing on the very next cycle
 * rather than after someone remembers to press Refresh.
 */
export async function POST(req: NextRequest) {
  const bad = (msg: string, code = 400) => NextResponse.json({ ok: false, error: msg }, { status: code });
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return bad("Body không hợp lệ");
    const { row, pickup_name } = body as { row?: number; pickup_name?: string };
    if (!Number.isInteger(row) || (row as number) < 2) return bad("Thiếu số dòng hợp lệ");
    if (!pickup_name?.trim()) return bad("Thiếu tên điểm lấy mẫu");

    await clearConfigRow({ row: row as number, expectPickup: pickup_name });
    await invalidateConfigCache();
    return NextResponse.json({ ok: true, row });
  } catch (e) {
    // A moved row or a Sunday attempt is the caller's to resolve, not a fault.
    return bad(e instanceof Error ? e.message : String(e), 409);
  }
}
