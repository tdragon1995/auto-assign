import { loadConfigFromSheets } from "./config";
import { invalidateLeaveCache, loadLeaveEntriesStrict } from "./leave-config";
import { loadLeaveSuppressions, suppressedThayCaRecordKeys } from "./leave-suppression";
import { syncThayCaRows } from "./sheets-writer";
import {
  deriveThayCaRows, parseSwapNote, parseThayCaNote, sourceKey,
  type SwapMeta,
} from "./thay-ca";

/** Rebuild generated duty-transfer rows while honoring explicit deletions. */
export async function reconcileThayCa(): Promise<{ created: number; updated: number; deleted: number }> {
  const [config, suppressions] = await Promise.all([
    loadConfigFromSheets(),
    loadLeaveSuppressions(),
  ]);
  if (!config) throw new Error("Chưa đọc được config để tạo dòng Thay ca");
  if (!suppressions.trusted) {
    throw new Error("Chưa đọc được danh sách Thay ca đã xoá — không tạo lại để tránh mất lựa chọn của quản trị viên");
  }
  const suppressedKeys = suppressedThayCaRecordKeys(suppressions.list);
  let total = { created: 0, updated: 0, deleted: 0 };

  for (let pass = 0; pass < 5; pass++) {
    const { entries } = await loadLeaveEntriesStrict();
    const byKey = new Map(entries.map((entry) => [
      sourceKey(entry.driver_id, entry.leave_from, entry.gio_bat_dau, entry.gio_ket_thuc), entry,
    ]));
    const swaps: SwapMeta[] = [];
    for (const entry of entries) {
      const meta = parseThayCaNote(entry.note);
      if (!meta || !meta.parentKey.startsWith("leave|") || !entry.subs.some((sub) => sub.id === meta.sourceDriverId)) continue;
      const source = byKey.get(meta.parentKey);
      if (!source) continue;
      const previous = parseSwapNote(source.note);
      swaps.push({
        sourceKey: meta.parentKey,
        originalType: previous?.originalType ?? meta.sourceLeaveType ?? source.loai_nghi,
        originalNote: previous?.originalNote ?? source.note ?? "",
      });
    }
    const desired = deriveThayCaRows(entries, config.mappings)
      .filter((row) => !suppressedKeys.has(row.recordKey));
    const result = await syncThayCaRows(desired, swaps);
    total = {
      created: total.created + result.created,
      updated: total.updated + result.updated,
      deleted: total.deleted + result.deleted,
    };
    if (result.created === 0 && result.updated === 0 && result.deleted === 0) break;
    await invalidateLeaveCache();
  }
  return total;
}
