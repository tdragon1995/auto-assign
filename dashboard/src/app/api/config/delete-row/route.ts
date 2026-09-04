import { NextRequest, NextResponse } from "next/server";
import { deleteConfigRow } from "@/lib/sheets-writer";
import { invalidateConfigCache } from "@/lib/config";

/**
 * Delete one config row — the fix for a duplicate rule, where the answer is not
 * "move a boundary" but "this line should not be here".
 *
 * The row is REMOVED, not blanked. Blanking was the first attempt and it left a
 * hole in the middle of the table that nothing ever reused: `configTableBounds`
 * looks for free space after the LAST non-blank pickup, so a blank in the middle
 * is skipped over. See deleteConfigRow for why removing a row inside the id
 * columns' spill is safe where writing into one is not.
 *
 * Invalidates the config so the branch stops clashing on the very next cycle,
 * and so the row numbers the dashboard is holding — every one below this row has
 * just shifted up — are re-derived rather than left stale.
 */
export async function POST(req: NextRequest) {
  const bad = (msg: string, code = 400) => NextResponse.json({ ok: false, error: msg }, { status: code });
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return bad("Body không hợp lệ");
    const { row, pickup_name } = body as { row?: number; pickup_name?: string };
    if (!Number.isInteger(row) || (row as number) < 2) return bad("Thiếu số dòng hợp lệ");
    if (!pickup_name?.trim()) return bad("Thiếu tên điểm lấy mẫu");

    await deleteConfigRow({ row: row as number, expectPickup: pickup_name });
    await invalidateConfigCache();
    return NextResponse.json({ ok: true, row });
  } catch (e) {
    // A moved row, row 2, or a Sunday attempt is the caller's to resolve.
    return bad(e instanceof Error ? e.message : String(e), 409);
  }
}
