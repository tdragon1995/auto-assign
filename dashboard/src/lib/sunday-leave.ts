/**
 * Cross-checking the hand-maintained Sunday roster against the leave module.
 *
 * WHY THIS EXISTS. The Sunday roster tab ("(Edit weekly) PUBLIC SUNDAY
 * SCHEDULE") is typed by ops a week ahead; leave is filed afterwards, through
 * MISA or the leave panel, and nothing has ever connected the two. So a driver
 * could be rostered for Sunday and be on approved leave for that same day, and
 * the first anyone learned of it was the shift starting without them. The
 * Sunday tab also feeds "(NO edit) CONFIG SUNDAY" through a spreadsheet
 * formula, so the engine inherits the same wrong belief.
 *
 * This does NOT try to fix the roster. It only says, beside each rostered name,
 * that the leave sheet disagrees — the repair stays a human edit in the tab
 * that a human maintains, because a roster row carries a location and a shift
 * that only ops can reassign.
 *
 * Pure string/array work over data passed in — no fetching, no caching — so it
 * can be exercised directly by a test.
 */
import type { LeaveOnDate } from "./leave-config";
import { matchDriverByName, type RosterEntry } from "./driver-match";

export interface SundayLeaveFlag {
  /** `leave` — the leave sheet has this person off that day. `unmatched` — the
   *  typed name ties to no single active account, so we cannot say either way
   *  and refuse to guess (the twin case: a bare name held by a PT and a DC
   *  account). An `unmatched` row is a sheet repair, not an absence. */
  status: "leave" | "unmatched";
  /** "HH:MM–HH:MM" for a windowed leave, null for a whole day. */
  timeLabel: string | null;
  /** The sheet's own leave type, shown rather than flattened. */
  loaiNghi: string;
  /** Substitutes named on the leave row, if any. Someone covering the absence
   *  is the difference between a hole in the Sunday shift and a handover. */
  subs: string[];
}

/** "dd/MM/yyyy" (the roster tab's own date format) → "YYYY-MM-DD", the format
 *  every leave function speaks. Null when it is not a date at all — a blank or
 *  a header leftover must not resolve to some default day, because a leave
 *  lookup against the wrong day answers "nobody is off" just as confidently. */
export function sundayDateToIso(s: string | null | undefined): string | null {
  const m = (s ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const day = Number(d), mon = Number(mo);
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  return `${y}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Minutes since midnight for "HH:MM" / "HH.MM" / "HHh", or -1. */
function toMin(t: string | null | undefined): number {
  const m = (t ?? "").trim().match(/^(\d{1,2})(?:[:.h](\d{2}))?/);
  if (!m) return -1;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return -1;
  return h * 60 + min;
}

/** The roster row's shift ("Ca") as minutes, or null when it cannot be read.
 *  Null is the FORGIVING answer: an unreadable shift means the row is compared
 *  on the day alone, so a half-day leave still shows rather than being dropped
 *  because the shift column was typed oddly. */
export function caWindow(ca: string | null | undefined): { from: number; to: number } | null {
  const parts = (ca ?? "").split(/[-–—]/);
  if (parts.length < 2) return null;
  const from = toMin(parts[0]);
  const to = toMin(parts[1]);
  if (from < 0 || to <= from) return null;
  return { from, to };
}

/** "HH:MM–HH:MM" → minutes, or null for a whole-day label. */
function labelWindow(label: string | null): { from: number; to: number } | null {
  if (!label) return null;
  const parts = label.split(/[-–—]/);
  if (parts.length < 2) return null;
  const from = toMin(parts[0]);
  const to = toMin(parts[1]);
  if (from < 0 || to <= from) return null;
  return { from, to };
}

/**
 * Whether a windowed leave actually eats into the shift the person is rostered
 * for. Compared BY THE HOUR, the same way `companionNeeded` compares them and
 * for the same reason: both sides are hand-typed and drift by a few minutes,
 * so a rule that answers differently for 14:59 and 15:00 is one nobody can
 * predict from looking at a roster.
 *
 * They must share a WHOLE HOUR (`<`, not `<=`). Merely touching at a boundary
 * is not a clash, and saying it is cost the feature its credibility on the
 * first real day it ran: on Sunday 20/09 the only flag it raised was a driver
 * rostered 06:00–15:00 whose leave began at 15:00 — the handover, reported as a
 * hole. That is also how the engine reads a shift end, which is exclusive.
 */
function touches(leave: { from: number; to: number }, shift: { from: number; to: number }): boolean {
  const h = (n: number) => Math.floor(n / 60);
  return Math.max(h(leave.from), h(shift.from)) < Math.min(h(leave.to), h(shift.to));
}

/**
 * The leave flag for one rostered name, or null when there is nothing to say.
 *
 * `rawName` is the roster's own cell, staff code and all — the code is tried
 * first by `matchDriverByName` and is the part of a label that survives a
 * rename, which is exactly why the code is NOT stripped before getting here.
 *
 * A blank name is an unfilled slot, not a person, so it is never flagged.
 */
export function leaveFlagFor(
  rawName: string,
  ca: string,
  roster: readonly RosterEntry[],
  leaveToday: readonly LeaveOnDate[],
): SundayLeaveFlag | null {
  if (!rawName.trim()) return null;

  const match = matchDriverByName(rawName, roster);
  // An empty roster means the roster sheet failed to load, not that nobody
  // works here — flagging every rostered name as unmatched off the back of that
  // would bury the real ones. Say nothing instead.
  if (roster.length === 0) return null;
  if (match.status !== "unique") return { status: "unmatched", timeLabel: null, loaiNghi: "", subs: [] };

  const shift = caWindow(ca);
  for (const e of leaveToday) {
    if (e.driver_id !== match.driver_id) continue;
    const window = labelWindow(e.timeLabel);
    // A whole-day leave always counts. A windowed one only where it meets the
    // rostered shift: a 06:00–10:00 absence against an afternoon shift is a
    // person who is there when the roster needs them.
    if (window && shift && !touches(window, shift)) continue;
    return {
      status: "leave",
      timeLabel: e.timeLabel,
      loaiNghi: e.loai_nghi,
      subs: e.subs.map((s) => s.name).filter(Boolean),
    };
  }
  return null;
}
