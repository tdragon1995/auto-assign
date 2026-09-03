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
 * So a delete also appends a line to the "Nghỉ phép đã xoá" tab, and
 * /api/nghi-phep refuses to re-create a day carrying one.
 *
 * TWO RULES KEEP THIS FROM BECOMING A SECOND TRUTH THAT DRIFTS.
 *
 * 1. It only ever blocks an AUTOMATED push. A person filing leave through the
 *    driver's form or the panel is never blocked, so a suppression can never be
 *    the reason a real day off failed to register — the way out is the ordinary
 *    action, not sheet surgery. It also means a day that comes back for a REAL
 *    reason (re-requested, re-approved, filed by hand) is never silently eaten.
 *
 * 2. It is a visible tab, listed in the dashboard's leave panel while it can
 *    still block anything, with a button that removes the line. A suppression
 *    nobody can see is the failure this design is avoiding, not a detail.
 *
 * Matching is EXACT on driver + day + window — never on the driver alone. Two
 * half-days on one date are two separate rows with two separate windows, and
 * deleting the morning one must not suppress the afternoon.
 */

import { fetchSheetRowsByName, isSheetShapeError, noteSheetLoad } from "./sheets";
import { timeToMins, vnDate } from "./time";

/** The tab a delete logs to, and the shape it is written and read in.
 *
 *  Defined HERE rather than beside the writer on purpose: this module is
 *  type-imported by client components, and `sheets-writer` pulls in googleapis.
 *  Keeping the tab's identity with its reader means the writer depends on the
 *  reader and never the other way round. */
export const LEAVE_DELETED_SHEET = "Nghỉ phép đã xoá";
export const LEAVE_DELETED_HEADERS = [
  "deleted_at", "driver_id", "driver", "Loại Nghỉ",
  "leave_from", "leave_to", "leave_from_hr", "leave_to_hr", "note",
] as const;

export interface LeaveSuppression {
  driver_id: string;
  driver_name: string;
  loai_nghi: string;
  leave_from: string;
  leave_to: string | null;
  gio_bat_dau: string | null;
  gio_ket_thuc: string | null;
  /** When the row was removed, and the note it carried — shown in the panel so a
   *  suppression can be judged without opening the workbook. */
  deleted_at: string;
  note: string;
}

/** The columns without which this tab cannot be read. Requiring them is what
 *  stops the gviz by-name lookup's wrong-tab answer (an unknown name returns the
 *  workbook's FIRST tab — here the ~1,700-row mapping table, which parses
 *  perfectly) from being mistaken for "no suppressions". See footgun 3. */
const REQUIRED = ["driver_id", "leave_from", "leave_from_hr", "leave_to_hr"] as const;

/** "2026-07-13" and "13/07/2026" both → "2026-07-13". Same normalisation the
 *  sheet writers use, because the tab's date cells carry whatever the cell's
 *  locale formatting gives. */
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
    if (s.driver_id !== candidate.driver_id) continue;
    if (windowKey(s.gio_bat_dau, s.gio_ket_thuc) !== want) continue;
    if (dates.some((d) => coversDate(s, d))) return s;
  }
  return null;
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

// A plain in-process TTL, on purpose. This list changes a handful of times a
// month and is read on the leave-WRITE path, never the assign cycle — the same
// reasoning the accepted-notes list is held under (see the command-budget header
// in smart-log-kv.ts). A stale copy costs one sync's delay in a suppression
// taking effect; a per-write sheet read costs a fetch on every submission.
let cache: { list: LeaveSuppression[]; at: number } | null = null;
const TTL_MS = 10 * 60 * 1000;

/**
 * Whether this process has ever read the tab successfully.
 *
 * The tab is created by the first delete, so "it is not there" is the correct
 * and expected state of every fresh deployment — and gviz answers an unknown
 * sheet name with the workbook's FIRST tab rather than a 404, so a missing tab
 * and a broken one arrive as the same contract failure. This flag is the only
 * thing that tells them apart: before a successful read, a failure is assumed to
 * be "nothing has been deleted yet" and stays quiet; after one, the tab is known
 * to exist and a failure raises the dashboard's sheet alarm.
 */
let everRead = false;

export function invalidateSuppressionCache(): void {
  cache = null;
}

export interface SuppressionLoad {
  list: LeaveSuppression[];
  /**
   * False when the list could not be read and is not a stale copy either — i.e.
   * it is empty because we do not know, not because nothing is suppressed.
   *
   * The distinction decides nothing about DISPLAY and everything about a write.
   * It deliberately does NOT fail closed: refusing every leave submission
   * because a tab could not be read would take out the driver's own leave form,
   * and on a first deploy the tab genuinely does not exist yet. An untrusted
   * read therefore lets the write through — which is exactly the behaviour
   * before this feature existed, so the worst case is a deleted row coming back
   * at the next sync, never a leave that could not be filed.
   */
  trusted: boolean;
}

/**
 * Read the tab.
 *
 * Never throws. A stale copy always beats an invented empty one: an empty list
 * answers "was this day deliberately removed?" with "no", which is the same
 * answer as "write it back again".
 */
export async function loadLeaveSuppressions(force = false): Promise<SuppressionLoad> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) {
    return { list: cache.list, trusted: true };
  }

  let rows: Record<string, string>[];
  try {
    rows = await fetchSheetRowsByName(LEAVE_DELETED_SHEET, {
      label: LEAVE_DELETED_SHEET,
      require: REQUIRED,
    });
  } catch (e) {
    if (cache) return { list: cache.list, trusted: true };
    if (everRead) {
      // The tab existed a moment ago, so this is a real fault — renamed,
      // permissions changed, an HTML error page. Put it on the dashboard banner
      // rather than quietly resuming the re-pushes this list is preventing.
      if (isSheetShapeError(e)) noteSheetLoad(e.sheetLabel, e);
      console.error(`[leave-suppression] "${LEAVE_DELETED_SHEET}" unreadable`, e);
      return { list: [], trusted: false };
    }
    // Never seen it — nothing has been deleted yet. Not a fault, not an alarm.
    return { list: [], trusted: true };
  }

  const list: LeaveSuppression[] = [];
  for (const r of rows) {
    const driver_id = (r["driver_id"] ?? "").trim();
    const leave_from = normDate(r["leave_from"]);
    if (!driver_id || !leave_from) continue;
    list.push({
      driver_id,
      driver_name: (r["driver"] ?? "").trim(),
      loai_nghi: (r["Loại Nghỉ"] ?? "").trim(),
      leave_from,
      leave_to: normDate(r["leave_to"]) || null,
      gio_bat_dau: (r["leave_from_hr"] ?? "").trim() || null,
      gio_ket_thuc: (r["leave_to_hr"] ?? "").trim() || null,
      deleted_at: (r["deleted_at"] ?? "").trim(),
      note: (r["note"] ?? "").trim(),
    });
  }
  everRead = true;
  noteSheetLoad(LEAVE_DELETED_SHEET, null);
  cache = { list, at: Date.now() };
  return { list, trusted: true };
}
