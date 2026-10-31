/**
 * Leave records: the shapes the leave writers take and the pure matching
 * helpers behind them. The writes themselves are in `master-leave.ts`.
 */
import { timeToMins } from "./time";


/**
 * What a leave row SAYS, independent of where the columns happen to sit.
 *
 * It was a positional array — `[ts, driver_id, driver_name, …]` — which is
 * exactly how `driver_id`, a FORMULA column, came to be written as a literal on
 * 76 rows of the live tab. Naming the fields makes the derived columns
 * unreachable rather than merely undocumented.
 */
export interface LeaveCells {
  submitted_at: string;
  driver_name: string;
  loai_nghi: string;
  leave_from: string;
  /** Blank on a resignation, which has no end. */
  leave_to?: string | null;
  leave_from_hr?: string | null;
  leave_to_hr?: string | null;
  note?: string | null;
}

export class LeaveWriteError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "LeaveWriteError";
  }
}

export interface LeaveSubWrite {
  /** Sheet display name — MUST match Driver!A:A exactly, or the row's
   *  sub#_id xlookup resolves blank and the engine drops the sub. */
  name: string;
  from: string | null; // "HH:MM" | null = inherit the leave's own window
  to: string | null;
}

export interface LeaveRowMatch {
  leave_id?: number;
  revision?: number;
  driver_id: string;
  leave_from: string; // YYYY-MM-DD as served by /api/leave-status
  /** "HH:MM–HH:MM" for a windowed row, null for full-day — same derivation as
   *  the panel's timeLabel, used to pick between same-day rows. */
  timeLabel: string | null;
  /** Delete/restore paths use the visible row's type to avoid hitting a normal
   * leave row that happens to share a generated Thay ca window. */
  loai_nghi?: string | null;
}

/** "2026-07-13" and "13/07/2026" both → "2026-07-13"; anything else verbatim. */
export function normDate(s: string): string {
  const t = (s ?? "").trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return t;
}

/** Window identity: minutes-pair for a valid window, "full" otherwise —
 *  format-insensitive ("6:30" vs "06:30"). */
function windowKey(from: string | null, to: string | null): string {
  const s = timeToMins(from || null);
  const e = timeToMins(to || null);
  return s >= 0 && e > s ? `${s}-${e}` : "full";
}


export interface LeaveSplitResult {
  rows: number[];
  created: number;
  warning?: string;
}

export function rowSubs(row: unknown[], col: Record<string, number>): LeaveSubWrite[] {
  const cell = (name: string) => col[name] == null ? "" : String(row[col[name]] ?? "").trim();
  return SUB_SLOTS.flatMap((n) => {
    const name = cell(`sub${n}_name`);
    const id = cell(`sub${n}_id`);
    if (!name && !id) return [];
    return [{ name, from: cell(`sub${n}_from`) || null, to: cell(`sub${n}_to`) || null }];
  });
}

export function sameSubs(a: readonly LeaveSubWrite[], b: readonly LeaveSubWrite[]): boolean {
  const normalized = (subs: readonly LeaveSubWrite[]) => subs.map((sub) => ({
    name: sub.name.trim(),
    from: sub.from ? timeToMins(sub.from) : null,
    to: sub.to ? timeToMins(sub.to) : null,
  }));
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
}


/** Which candidate row an EDIT applies to: the MOST-covered one — the row
 *  `leaveEntriesOnDate`'s "most subs wins" collapse is showing on screen right
 *  now. Opposite of {@link pickLeaveRowToDelete}, and for the opposite reason:
 *  a delete wants to drop the redundant empty copy, an edit wants to change
 *  the one substitute actually on the record. Ties go to the earliest row. */
export function pickLeaveRowToEdit(candidates: LeaveRowCandidate[]): number | null {
  let best: LeaveRowCandidate | null = null;
  for (const c of candidates) {
    if (!best || c.subCount > best.subCount || (c.subCount === best.subCount && c.row < best.row)) {
      best = c;
    }
  }
  return best ? best.row : null;
}

export interface LeaveRowCandidate {
  /** 1-based sheet row. */
  row: number;
  /** How many substitute slots are filled — a covered row is the one to KEEP. */
  subCount: number;
  driver_name: string;
  loai_nghi: string;
  leave_from: string;
  leave_to: string | null;
  /** The row's own hour window, verbatim from the sheet. Recorded rather than
   *  re-derived from the panel's label so a suppression matches the row that
   *  actually went, down to a "6:00" the panel rendered as "06:00". */
  leave_from_hr: string | null;
  leave_to_hr: string | null;
  note: string;
}

/** The sub slots the loader reads (`buildSub` walks 1–4), not the three the
 *  sub-editor writes: a row can carry a fourth filled in by hand. */
const SUB_SLOTS = [1, 2, 3, 4];

/**
 * Every row that IS the leave the dashboard is pointing at: same driver, same
 * start date, same window. Identity is re-derived from the sheet at write time
 * (never a row number carried by the client), so an edit that shifted rows
 * cannot make this hit the wrong line.
 *
 * Pure — takes the parsed grid — so the choice below can be pinned by a test.
 */
export function matchLeaveRows(
  all: unknown[][],
  col: Record<string, number>,
  match: LeaveRowMatch,
): LeaveRowCandidate[] {
  const cell = (row: unknown[], name: string): string =>
    col[name] == null ? "" : String(row[col[name]] ?? "").trim();
  const targetDate = normDate(match.leave_from);
  const [mFrom, mTo] = (match.timeLabel ?? "").split("–");
  const targetWindow = match.timeLabel ? windowKey(mFrom, mTo) : "full";

  const out: LeaveRowCandidate[] = [];
  for (let r = 1; r < all.length; r++) {
    const row = all[r];
    if (!row) continue;
    if (cell(row, "driver_id") !== match.driver_id) continue;
    if (normDate(cell(row, "leave_from")) !== targetDate) continue;
    if (windowKey(cell(row, "leave_from_hr"), cell(row, "leave_to_hr")) !== targetWindow) continue;
    if (match.loai_nghi && cell(row, "Loại Nghỉ") !== match.loai_nghi) continue;
    out.push({
      row: r + 1, // 1-based sheet row
      subCount: SUB_SLOTS.filter((n) => cell(row, `sub${n}_name`) || cell(row, `sub${n}_id`)).length,
      driver_name: cell(row, "driver"),
      loai_nghi: cell(row, "Loại Nghỉ"),
      leave_from: normDate(cell(row, "leave_from")),
      leave_to: normDate(cell(row, "leave_to")) || null,
      leave_from_hr: cell(row, "leave_from_hr") || null,
      leave_to_hr: cell(row, "leave_to_hr") || null,
      note: cell(row, "note"),
    });
  }
  return out;
}

/**
 * Which of several identical rows to remove.
 *
 * Fewest substitutes first: when the sheet holds the duplicate pair this panel
 * already flags — one row the requester typed and one the supervisor filled
 * cover into — the empty one is the redundant copy and the covered one is the
 * record. Ties go to the LAST row, i.e. the most recently appended, which is the
 * one a re-push added.
 *
 * One row per call, deliberately: deleting a whole duplicate set on one click
 * would take the covered row with it.
 */
export function pickLeaveRowToDelete(candidates: LeaveRowCandidate[]): LeaveRowCandidate | null {
  let best: LeaveRowCandidate | null = null;
  for (const c of candidates) {
    if (!best || c.subCount < best.subCount || (c.subCount === best.subCount && c.row > best.row)) {
      best = c;
    }
  }
  return best;
}

export interface LeaveRowDeletion {
  /** The 1-based sheet row that was removed. */
  row: number;
  driver_name: string;
  loai_nghi: string;
  leave_from: string;
  leave_to: string | null;
  leave_from_hr: string | null;
  leave_to_hr: string | null;
  note: string;
  /** Identical rows still on the sheet after this one went — a duplicate set
   *  needs one click per copy, and the caller says so rather than leaving the
   *  supervisor to notice the flag did not clear. */
  remaining: number;
}
