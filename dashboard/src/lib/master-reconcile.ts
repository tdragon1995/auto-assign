import { createHash, randomUUID } from "node:crypto";

export const RECORD_ID = "_master_record_id";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PROXY_ID = "6437bace-6578-11f1-9378-fa163ee8d8ac";
export type SourceRow = { source_row: number; row_data: Record<string, string> };
export type StoredRow = SourceRow & { id: number; source_uid: string; active: boolean; smart_driver_id_manual?: string | null };
export type IdentifiedRow = SourceRow & { source_uid: string; previous?: StoredRow };
export function content(row: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(row)
    .filter(([key, value]) => key !== RECORD_ID && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))));
}
export const sourceHash = (rows: SourceRow[]) => createHash("sha256")
  .update(JSON.stringify(rows.map(r => [r.source_row, content(r.row_data)]))).digest("hex");

/** A row number is never evidence of identity. Ambiguous legacy duplicates need review. */
export function reconcile(source: SourceRow[], stored: StoredRow[], preserveEquivalentCopies = false) {
  const byUid = new Map(stored.map(r => [r.source_uid, r]));
  const used = new Set<string>();
  const changes: { kind: string; row: number; previous_row?: number; id?: number }[] = [];
  const ambiguous: { row: number; candidates: number[] }[] = [];
  const equivalentCopies: { row:number; id:number; reason:string }[] = [];
  const without = (row: Record<string,string>, keys:string[]) => content(Object.fromEntries(Object.entries(row).filter(([k])=>!keys.includes(k))));
  const anchors = [
    ["shift_start","shift_end"],
    ["driver_id","smart_driver_id","first_name_last_name","Driver"],
  ];
  const rows: IdentifiedRow[] = source.map(row => {
    const uid = row.row_data[RECORD_ID]?.trim().toLowerCase();
    if (uid && !UUID.test(uid)) throw new Error(`Row ${row.source_row}: invalid ${RECORD_ID}`);
    if (uid && used.has(uid)) throw new Error(`Row ${row.source_row}: duplicate ${RECORD_ID} ${uid}`);
    let old = uid ? byUid.get(uid) : undefined;
    if (!uid) {
      const matches = stored.filter(r => r.active && !used.has(r.source_uid) && content(r.row_data) === content(row.row_data));
      if (matches.length === 1) old = matches[0];
      else if (matches.length > 1) {
        const key=content(row.row_data);
        const group=stored.filter(r=>r.active && content(r.row_data)===key);
        const sourceGroup=source.filter(r=>content(r.row_data)===key);
        if(preserveEquivalentCopies && group.length===sourceGroup.length && group.every(r=>r.smart_driver_id_manual==null)) {
          // No pre-existing permanent Sheet identity distinguishes identical copies.
          // Preserve their count and complete contents, pairing occurrences in source order.
          old=[...matches].sort((a,b)=>a.source_row-b.source_row)[0];
          equivalentCopies.push({row:row.source_row,id:old.id,reason:"Identical contents; retained as separate records"});
        } else ambiguous.push({ row: row.source_row, candidates: matches.map(r => r.id) });
      }
      else if (row.row_data.customer_id) {
        // A unique, otherwise identical record can have an edited shift or driver selection.
        // Require uniqueness on BOTH sides; never borrow a same-position rule.
        for (const keys of anchors) {
          const anchor=without(row.row_data,keys);
          const candidates=stored.filter(r=>r.active && !used.has(r.source_uid) && without(r.row_data,keys)===anchor);
          if (candidates.length===1 && source.filter(r=>without(r.row_data,keys)===anchor).length===1) {old=candidates[0];break;}
        }
      }
    }
    const source_uid = uid || old?.source_uid || randomUUID();
    if (used.has(source_uid)) throw new Error(`Row ${row.source_row}: duplicate identity`);
    used.add(source_uid);
    const kind = !old ? "added" : content(old.row_data) !== content(row.row_data) ? "edited"
      : old.source_row !== row.source_row ? "moved" : "unchanged";
    changes.push({ kind, row: row.source_row, previous_row: old?.source_row, id: old?.id });
    return { ...row, source_uid, previous: old };
  });
  const removed = stored.filter(r => r.active && !used.has(r.source_uid));
  const overrideConflicts = removed.filter(r => r.smart_driver_id_manual != null)
    .map(r => ({ id: r.id, previous_row: r.source_row, reason: "Unmatched manual Smart selection" }));
  for (const row of rows) {
    if (row.previous?.smart_driver_id_manual && row.previous.smart_driver_id_manual !== row.row_data.smart_driver_id) {
      overrideConflicts.push({ id: row.previous.id, previous_row: row.previous.source_row, reason: "Sheet changed manual Smart selection" });
    }
  }
  return { rows, report: { changes, removed: removed.map(r => ({ id: r.id, row: r.source_row })), ambiguous, equivalentCopies, overrideConflicts } };
}

function localTime(value: string | undefined, field: string, issues: string[]): string | null {
  if (!value?.trim()) return null;
  const match = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/.exec(value.trim());
  if (!match || (Number(match[1]) > 23 && value.trim() !== "24:00")) { issues.push(`${field}: ${value}`); return null; }
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}
function localDate(value: string | undefined, field: string, issues: string[]): string | null {
  if (!value?.trim()) return null;
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  const vn = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  const date = match ? `${match[1]}-${match[2].padStart(2,"0")}-${match[3].padStart(2,"0")}`
    : vn ? `${vn[3]}-${vn[2].padStart(2,"0")}-${vn[1].padStart(2,"0")}` : "";
  if (!date || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) {
    issues.push(`${field}: ${value}`); return null;
  }
  return date;
}
function linked(value: string | undefined, field: string, known: Set<string>, issues: string[]) {
  if (!value?.trim()) return null;
  const id = value.trim().toLowerCase();
  if (!UUID.test(id) || !known.has(id)) { issues.push(`${field}: ${value}`); return null; }
  return id;
}
export function normalizeRule(row: IdentifiedRow, clients: Set<string>, drivers: Set<string>) {
  const r = row.row_data, review_issues: string[] = [];
  const pickup_customer_id = linked(r.customer_id,"customer_id",clients,review_issues);
  const dropoff_customer_id = linked(r.dropoff_id,"dropoff_id",clients,review_issues);
  const alternate_dropoff_customer_id = linked(r.alt_drop_off_id,"alt_drop_off_id",clients,review_issues);
  const assignment_mode = r.smart_driver_id?.trim() ? "smart" : "fixed";
  const selected = assignment_mode === "smart" ? r.smart_driver_id.split(",") : [r.driver_id];
  let driver_ids = selected.map(id => linked(id,"driver_id",drivers,review_issues)).filter((id): id is string => !!id);
  if (driver_ids.includes(PROXY_ID)) review_issues.push("3PL proxy cannot be an assignable driver");
  if (new Set(driver_ids).size !== driver_ids.length) review_issues.push("Duplicate selected drivers");
  const shift_start = localTime(r.shift_start,"shift_start",review_issues);
  const shift_end = localTime(r.shift_end,"shift_end",review_issues);
  if (!!shift_start !== !!shift_end) review_issues.push("Incomplete shift window");
  // A partially parsed Smart list must not silently become an active subset.
  if (review_issues.length || !pickup_customer_id) driver_ids = [];
  return { source_uid: row.source_uid, source_row: row.source_row, row_data: r, assignment_mode,
    pickup_customer_id, dropoff_customer_id, alternate_dropoff_customer_id, driver_ids, shift_start, shift_end, review_issues };
}
export function normalizeLeave(row: IdentifiedRow, drivers: Set<string>) {
  const r = row.row_data, review_issues: string[] = [];
  const linked_driver_id = linked(r.driver_id,"driver_id",drivers,review_issues);
  const starts_on = localDate(r.leave_from,"leave_from",review_issues);
  const ends_on = localDate(r.leave_to,"leave_to",review_issues);
  const starts_at = localTime(r.leave_from_hr,"leave_from_hr",review_issues);
  const ends_at = localTime(r.leave_to_hr,"leave_to_hr",review_issues);
  const substitutes = [];
  for (let i=1;i<=4;i++) {
    const id=r[`sub${i}_id`];
    if (!id && !r[`sub${i}_name`]) continue;
    const coverage_kind = id?.trim().toLowerCase() === PROXY_ID ? "3pl" : "driver";
    const driver_id = coverage_kind === "3pl" ? null : linked(id,`sub${i}_id`,drivers,review_issues);
    const from = localTime(r[`sub${i}_from`],`sub${i}_from`,review_issues);
    const to = localTime(r[`sub${i}_to`],`sub${i}_to`,review_issues);
    if (coverage_kind === "driver" && !driver_id) { review_issues.push(`sub${i}: unresolved coverage`); continue; }
    substitutes.push({ selection_order:i,coverage_kind,driver_id,starts_at:from,ends_at:to });
  }
  return { source_uid:row.source_uid,source_row:row.source_row,row_data:r,linked_driver_id,
    starts_on,ends_on,starts_at,ends_at,substitutes,review_issues };
}
