/**
 * Leave rows a supervisor deliberately removed, and which must therefore stay
 * removed.
 *
 * WHY THIS EXISTS. Deleting a leave row does not settle anything on its own. The
 * MISA pusher re-derives every charged day from today forward on every run and
 * dedupes purely on the row being present on the sheet — so a future day MISA
 * still charges is written straight back at the next 04:45 / 12:00 sync. That is
 * precisely the case the delete button was built for: a request approved only in
 * PART, where MISA's own record has not moved.
 *
 * So a delete also records the day in `master_leave_suppressions`, and
 * /api/nghi-phep refuses to re-create a day carrying one.
 *
 * TWO RULES KEEP THIS FROM BECOMING A SECOND TRUTH THAT DRIFTS.
 *
 * 1. It only ever blocks an AUTOMATED push. A person filing leave through the
 *    driver's form or the panel is never blocked, so a suppression can never be
 *    the reason a real day off failed to register — the way out is the ordinary
 *    action, not database surgery. It also means a day that comes back for a REAL
 *    reason (re-requested, re-approved, filed by hand) is never silently eaten.
 *
 * 2. It is a visible list in the dashboard's leave panel while it can
 *    still block anything, with a button that removes the line. A suppression
 *    nobody can see is the failure this design is avoiding, not a detail.
 *
 * Matching is EXACT on driver + day + window — never on the driver alone. Two
 * half-days on one date are two separate rows with two separate windows, and
 * deleting the morning one must not suppress the afternoon.
 */

import { sbSelectAll, sbInsert, sbDelete } from "./supabase-rest";
import type { LeaveRowDeletion, LeaveRowMatch } from "./leave-rows";
import { timeToMins, vnDate } from "./time";
import { parseThayCaNote, THAY_CA_LABEL } from "./thay-ca";
import { unwrapLeaveSplitNote } from "./leave-split";

export interface LeaveSuppression {
  driver_id: string;
  driver_name: string;
  loai_nghi: string;
  leave_from: string;
  leave_to: string | null;
  gio_bat_dau: string | null;
  gio_ket_thuc: string | null;
  /** When the row was removed, and the note it carried — shown in the panel so a
   *  suppression can be judged at a glance. */
  deleted_at: string;
  note: string;
}

/** "2026-07-13" and "13/07/2026" both → "2026-07-13". Same normalisation the
 *  leave writers use. */
function normDate(s: string | null | undefined): string {
  const t = (s ?? "").trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return t;
}

/** Window identity: a minutes-pair for a real window, "full" otherwise — so
 *  "6:00" and "06:00" are the same window and a blank pair is the whole day. */
export function windowKey(from: string | null, to: string | null): string {
  const s = timeToMins(from || null);
  const e = timeToMins(to || null);
  return s >= 0 && e > s ? `${s}-${e}` : "full";
}

/** One day at a time, bounded — a suppression covers each day of its range the
 *  same way a leave row does. */
function coversDate(s: LeaveSuppression, date: string): boolean {
  const to = s.leave_to || s.leave_from;
  return !!s.leave_from && s.leave_from <= date && date <= to;
}

/** The dates a submission would occupy, bounded against a malformed range. */
function candidateDates(from: string, to: string | null): string[] {
  const end = to && to >= from ? to : from;
  const out: string[] = [];
  const cur = new Date(from + "T00:00:00Z");
  for (let i = 0; i < 400; i++) {
    const d = cur.toISOString().slice(0, 10);
    if (d > end) break;
    out.push(d);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out.length ? out : [from];
}

/**
 * The suppression that blocks `candidate`, or null.
 *
 * Pure, so the rule can be pinned offline. The caller decides WHETHER to consult
 * it — only an automated push is subject to one.
 */
export function findSuppression(
  candidate: {
    driver_id: string;
    leave_from: string;
    leave_to: string | null;
    gio_bat_dau: string | null;
    gio_ket_thuc: string | null;
  },
  list: readonly LeaveSuppression[],
): LeaveSuppression | null {
  if (!candidate.driver_id || !candidate.leave_from) return null;
  const want = windowKey(candidate.gio_bat_dau, candidate.gio_ket_thuc);
  const dates = candidateDates(normDate(candidate.leave_from), normDate(candidate.leave_to) || null);
  for (const s of list) {
    // Generated duty transfers have their own reconciliation suppression. They
    // must never block a real MISA leave that happens to share the same hours.
    if (s.loai_nghi === THAY_CA_LABEL) continue;
    if (s.driver_id !== candidate.driver_id) continue;
    if (windowKey(s.gio_bat_dau, s.gio_ket_thuc) !== want) continue;
    if (dates.some((d) => coversDate(s, d))) return s;
  }
  return null;
}

/** Generated record identities a supervisor explicitly deleted. */
export function suppressedThayCaRecordKeys(list: readonly LeaveSuppression[]): Set<string> {
  const keys = new Set<string>();
  for (const suppression of list) {
    if (suppression.loai_nghi !== THAY_CA_LABEL) continue;
    const meta = parseThayCaNote(unwrapLeaveSplitNote(suppression.note));
    if (meta?.recordKey) keys.add(meta.recordKey);
  }
  return keys;
}

/**
 * Suppressions that can still block something.
 *
 * A day already past is never re-pushed — the pusher floors its range at today —
 * so an old line is dead weight on the panel and is filtered out of the display.
 * It is NOT deleted: the tab is the audit trail of what was removed and why.
 */
export function liveSuppressions(
  list: readonly LeaveSuppression[],
  today = vnDate(),
): LeaveSuppression[] {
  return list
    .filter((s) => (s.leave_to || s.leave_from) >= today)
    .sort((a, b) => (a.leave_from < b.leave_from ? -1 : a.leave_from > b.leave_from ? 1 : 0));
}

export interface SuppressionLoad {
  list: LeaveSuppression[];
  /**
   * False when the list could not be read — i.e. it is empty because we do not
   * know, not because nothing is suppressed.
   *
   * The distinction decides nothing about DISPLAY and everything about a write.
   * It deliberately does NOT fail closed: refusing every leave submission
   * because the list could not be read would take out the driver's own leave
   * form. An untrusted read therefore lets the write through — which is exactly the behaviour
   * before this feature existed, so the worst case is a deleted row coming back
   * at the next sync, never a leave that could not be filed.
   */
  trusted: boolean;
}

/** Read the list. Never throws: a failed read comes back untrusted (see above). */
export async function loadLeaveSuppressions(): Promise<SuppressionLoad> {
  try {
    const list = await sbSelectAll<LeaveSuppression>("master_leave_suppressions", "select=driver_id,driver_name,loai_nghi,leave_from,leave_to,gio_bat_dau,gio_ket_thuc,deleted_at,note", "id.asc");
    return { list, trusted: true };
  } catch (e) { console.error("[leave-suppression] Supabase unavailable", e); return { list: [], trusted: false }; }
}

export async function appendMasterLeaveDeletion(deleted:LeaveRowDeletion,driver_id:string) {
  await sbInsert("master_leave_suppressions", [{driver_id,driver_name:deleted.driver_name,loai_nghi:deleted.loai_nghi,
    leave_from:normDate(deleted.leave_from),leave_to:normDate(deleted.leave_to)||null,
    gio_bat_dau:deleted.leave_from_hr,gio_ket_thuc:deleted.leave_to_hr,note:deleted.note}]);
}
export async function removeMasterLeaveSuppression(match:LeaveRowMatch) {
  const rows=await sbSelectAll<LeaveSuppression & {id:number}>("master_leave_suppressions","select=*","id.asc");
  const [start,end]=(match.timeLabel??"").split("–");
  const target=rows.filter(r=>r.driver_id===match.driver_id && r.leave_from===normDate(match.leave_from) &&
    windowKey(r.gio_bat_dau,r.gio_ket_thuc)===(match.timeLabel?windowKey(start,end):"full") &&
    (!match.loai_nghi || r.loai_nghi===match.loai_nghi)).at(-1);
  if(!target) throw new Error("Không tìm thấy dòng đã xoá — tải lại rồi thử lại");
  await sbDelete("master_leave_suppressions",`id=eq.${target.id}`);
  return {row:target.id,loai_nghi:target.loai_nghi};
}
