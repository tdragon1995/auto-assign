import { NextRequest, NextResponse } from "next/server";
import { deleteConfigRow, ConfigRowChangedError } from "@/lib/sheets-writer";
import { parseConfigRowSnapshot } from "@/lib/config-row-match";
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
    const { row, pickup_name, expected_row } = body as { row?: number; pickup_name?: string; expected_row?: unknown };
    if (!Number.isInteger(row) || (row as number) < 2) return bad("Thiếu số dòng hợp lệ");
    if (!pickup_name?.trim()) return bad("Thiếu tên điểm lấy mẫu");
    const expected = expected_row === undefined ? undefined : parseConfigRowSnapshot(expected_row);
    if (expected_row !== undefined && !expected) return bad("Thông tin dòng cũ không hợp lệ");

    const result = await deleteConfigRow({ row: row as number, expectPickup: pickup_name, expected: expected ?? undefined });
    await invalidateConfigCache();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof ConfigRowChangedError) {
      return NextResponse.json({ ok: false, code: e.code, error: e.message }, { status: 409 });
    }
    // A moved row, row 2, or a Sunday attempt is the caller's to resolve.
    return bad(e instanceof Error ? e.message : String(e), 409);
  }
}
