import { loadDayMappings } from "./day-config";
import { invalidateLeaveCache, loadLeaveEntriesStrict } from "./leave-config";
import { loadLeaveSuppressions, suppressedThayCaRecordKeys } from "./leave-suppression";
import { appendMasterLeave, deleteMasterLeaves, masterLeaveRecords, updateMasterLeave } from "./master-leave";
import type { LeaveCells } from "./leave-rows";
import { replaceSplitOriginalNote, unwrapLeaveSplitNote } from "./leave-split";
import {
  deriveThayCaRows, encodeSwapNote, parseSwapNote, parseThayCaNote, sourceKey, THAY_CA_NOTE_PREFIX,
  type SwapMeta, type ThayCaDesired,
} from "./thay-ca";

/** Rebuild generated duty-transfer rows while honoring explicit deletions. */
export async function reconcileThayCa(): Promise<{ created: number; updated: number; deleted: number }> {
  // BOTH config tabs, because a leave row carries its own date and Sunday has
  // its own rules. Judging every row against today's tab generated a Thay ca
  // for a Sunday-only driver's Monday leave, and missed real Sunday conflicts
  // on every other day of the week. See `day-config.ts`.
  const [mappingsFor, suppressions] = await Promise.all([
    loadDayMappings(),
    loadLeaveSuppressions(),
  ]);
  if (!mappingsFor) throw new Error("Chưa đọc được config để tạo dòng Thay ca");
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
    const desired = deriveThayCaRows(entries, (date) => mappingsFor.forDate(date))
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

/**
 * Reconcile generated Thay ca rows by their provenance marker. Existing rows
 * retain their substitute slots while their overlap window is trimmed or moved.
 */
async function syncThayCaRows(
  desired: readonly ThayCaDesired[],
  swaps: readonly SwapMeta[] = [],
): Promise<{
  created: number;
  updated: number;
  deleted: number;
}> {
  const rows = await masterLeaveRecords();
  const existing = rows.filter((row) => unwrapLeaveSplitNote(row.values.note).startsWith(THAY_CA_NOTE_PREFIX));
  const desiredByKey = new Map(desired.map((row) => [row.recordKey, row]));
  const used = new Set<string>();
  const updates: Promise<void>[] = [];
  let updated = 0;

  for (const row of existing) {
    let meta: { recordKey?: string } = {};
    const parsed = parseThayCaNote(unwrapLeaveSplitNote(row.values.note));
    if (parsed) meta = parsed;
    const wanted = meta.recordKey ? desiredByKey.get(meta.recordKey) : undefined;
    if (!wanted || used.has(wanted.recordKey)) continue;
    used.add(wanted.recordKey);
    const next: LeaveCells = {
      submitted_at: row.values["Ngày Nộp Đơn"] || new Date().toISOString(),
      driver_name: wanted.driver_name,
      loai_nghi: "Thay ca",
      leave_from: wanted.leave_from,
      leave_to: wanted.leave_to,
      leave_from_hr: wanted.leave_from_hr,
      leave_to_hr: wanted.leave_to_hr,
      note: replaceSplitOriginalNote(row.values.note, wanted.note),
    };
    const changed = [
      row.values.driver !== next.driver_name,
      row.values["Loại Nghỉ"] !== next.loai_nghi,
      row.values.leave_from !== next.leave_from,
      row.values.leave_to !== next.leave_to,
      row.values.leave_from_hr !== next.leave_from_hr,
      row.values.leave_to_hr !== next.leave_to_hr,
      row.values.note !== next.note,
    ].some(Boolean);
    if (changed) { updated++; updates.push(updateMasterLeave(row.row, next,row.revision)); }
  }
  await Promise.all(updates);

  // A reciprocal assignment is a deliberate swap. Mark the original leave as
  // Thay ca for the same interval, then restore its original type/note as soon
  // as the reciprocal substitute is removed.
  const swapsByKey = new Map(swaps.map((swap) => [swap.sourceKey, swap]));
  const swapUpdates: Promise<void>[] = [];
  for (const row of rows) {
    const operationalNote = unwrapLeaveSplitNote(row.values.note);
    if (operationalNote.startsWith(THAY_CA_NOTE_PREFIX)) continue;
    const key = row.values.driver_id && row.values.leave_from
      ? sourceKey(row.values.driver_id, row.values.leave_from, row.values.leave_from_hr || null, row.values.leave_to_hr || null)
      : "";
    const active = key ? swapsByKey.get(key) : undefined;
    const previous = parseSwapNote(operationalNote);
    if (!active && !previous) continue;
    const nextType = active ? "Thay ca" : previous!.originalType;
    const nextNote = replaceSplitOriginalNote(
      row.values.note,
      active ? encodeSwapNote(active) : previous!.originalNote,
    );
    if (row.values["Loại Nghỉ"] === nextType && row.values.note === nextNote) continue;
    updated++;
    swapUpdates.push(updateMasterLeave(row.row, {
      submitted_at: row.values["Ngày Nộp Đơn"] || new Date().toISOString(),
      driver_name: row.values.driver,
      loai_nghi: nextType,
      leave_from: row.values.leave_from,
      leave_to: row.values.leave_to || null,
      leave_from_hr: row.values.leave_from_hr || null,
      leave_to_hr: row.values.leave_to_hr || null,
      note: nextNote,
    }, row.revision));
  }
  await Promise.all(swapUpdates);

  const obsolete = existing
    .filter((row) => {
      let key = "";
      try { key = String(parseThayCaNote(unwrapLeaveSplitNote(row.values.note))?.recordKey ?? ""); } catch { /* malformed */ }
      return !key || !used.has(key) || !desiredByKey.has(key);
    })
    .map((row) => row.row);
  await deleteMasterLeaves(obsolete,new Map(rows.map(r=>[r.row,r.revision??0])));

  const missing = desired.filter((row) => !used.has(row.recordKey)).map((row): LeaveCells => ({
    submitted_at: new Date().toISOString(), driver_name: row.driver_name, loai_nghi: "Thay ca",
    leave_from: row.leave_from, leave_to: row.leave_to,
    leave_from_hr: row.leave_from_hr, leave_to_hr: row.leave_to_hr, note: row.note,
  }));
  if (missing.length) await appendMasterLeave(missing);
  return { created: missing.length, updated, deleted: obsolete.length };
}
