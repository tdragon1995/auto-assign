import { resolveConfigDay } from "@/lib/config-day";
import { NextRequest, NextResponse } from "next/server";
import { editMasterConfig, weekdayOnly } from "@/lib/master-config-actions";
import { parseConfigRowSnapshot } from "@/lib/config-row-match";
import { invalidateConfigCache } from "@/lib/config";

/**
 * Delete one config rule — the fix for a duplicate rule, where the answer is not
 * "move a boundary" but "this line should not be here". The rule is switched off
 * (history kept), matched by rule id + revision.
 *
 * Invalidates the config so the branch stops clashing on the very next cycle.
 */
export async function POST(req: NextRequest) {
  const bad = (msg: string, code = 400) => NextResponse.json({ ok: false, error: msg }, { status: code });
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return bad("Body không hợp lệ");
    const configDay = resolveConfigDay(body.config_day);
    const { row, pickup_name, expected_row } = body as { row?: number; pickup_name?: string; expected_row?: unknown };
    if (!Number.isInteger(row) || (row as number) < 2) return bad("Thiếu số dòng hợp lệ");
    if (!pickup_name?.trim()) return bad("Thiếu tên điểm lấy mẫu");
    const expected = expected_row === undefined ? undefined : parseConfigRowSnapshot(expected_row);
    if (expected_row !== undefined && !expected) return bad("Thông tin dòng cũ không hợp lệ");

    weekdayOnly(configDay);
    const result = await editMasterConfig({ row: row as number, expectPickup: pickup_name, expected: expected ?? undefined }, { delete: true });
    await invalidateConfigCache();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // A changed rule or a Sunday attempt is the caller's to resolve.
    return bad(e instanceof Error ? e.message : String(e), 409);
  }
}
