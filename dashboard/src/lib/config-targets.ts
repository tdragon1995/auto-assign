/**
 * The row list every bulk config route takes: `[{ row, pickup_name }]`, where
 * the pickup is what the dashboard SAW on that row — the writer compares it
 * against the live sheet before touching anything.
 *
 * Capped, because the whole list is checked in memory against one column read
 * and written in one batch; 500 is several times any real selection and keeps a
 * malformed request from asking for the whole sheet.
 */
import { parseConfigRowSnapshot, type ConfigRowSnapshot } from "./config-row-match";

export const MAX_BULK_ROWS = 500;

export type ConfigTarget = { row: number; expectPickup: string; expected?: ConfigRowSnapshot };

export function parseConfigTargets(
  rows: unknown,
): { targets: ConfigTarget[] } | { error: string } {
  if (!Array.isArray(rows) || rows.length === 0) return { error: "Chưa chọn dòng nào" };
  if (rows.length > MAX_BULK_ROWS) return { error: `Tối đa ${MAX_BULK_ROWS} dòng một lần` };
  const targets: ConfigTarget[] = [];
  for (const r of rows as { row?: unknown; pickup_name?: unknown; expected_row?: unknown }[]) {
    if (!Number.isInteger(r?.row) || (r.row as number) < 2) return { error: "Có dòng thiếu số dòng hợp lệ" };
    if (typeof r.pickup_name !== "string" || !r.pickup_name.trim()) {
      return { error: `Dòng ${r.row} thiếu tên điểm lấy mẫu` };
    }
    const expected = r.expected_row === undefined ? undefined : parseConfigRowSnapshot(r.expected_row);
    if (r.expected_row !== undefined && !expected) return { error: `Dòng ${r.row} có thông tin cũ không hợp lệ` };
    targets.push({ row: r.row as number, expectPickup: r.pickup_name, expected: expected ?? undefined });
  }
  return { targets };
}
