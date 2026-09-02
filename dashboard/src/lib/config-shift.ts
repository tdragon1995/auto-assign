/**
 * The shift arithmetic behind the config editor, kept out of the component so it
 * can be pinned offline.
 *
 * All of this decides what gets WRITTEN into the roster sheet — a boundary moved
 * onto a neighbour makes the engine refuse the branch's jobs outright — so it is
 * exercised by scripts/config-shift.test.mts rather than only by clicking.
 */
import type { BranchRule, CoverageGap } from "./types";


export const toMin = (v: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};

/**
 * Whether a time falls INSIDE a rule that already exists — strictly inside, so a
 * clean handover is still allowed.
 *
 * Windows here are half-open: a rule covers (start, end], so a new rule may
 * begin exactly where another ends and they will never both be on duty. Only
 * the minutes properly between the two ends are taken.
 */
export function insideBusy(t: string, busy: readonly [string, string][]): boolean {
  const m = toMin(t);
  if (m < 0) return false;
  return busy.some(([f, e]) => {
    const a = toMin(f), b = toMin(e);
    if (a < 0 || b < 0 || a === b) return false;
    return a < b ? m > a && m < b : m > a || m < b;   // the second case wraps midnight
  });
}

/** A line as the editor holds it while being worked on. */
export interface Line {
  /**
   * Stable identity for one line within a single editing session.
   *
   * Deliberately NOT the sheet row: a line being added has no row until the
   * write comes back, and that is precisely the line a retry has to recognise —
   * otherwise a second attempt appends a second copy of it. Survives the row
   * being adopted after a successful add, and keeps the React key honest when a
   * line in the middle is dropped.
   */
  key: string;
  /** The sheet row this came from, or undefined for one being added. */
  row?: number;
  driver: string;
  start: string;
  end: string;
}

let newLineSeq = 0;
export const newLineKey = () => `new:${++newLineSeq}`;

export const asLine = (r: BranchRule): Line => ({
  key: `row:${r.row}`, row: r.row, driver: r.driver, start: r.start, end: r.end,
});

/** What a line would WRITE. Two lines with the same signature put the same
 *  content in the sheet, which is what makes "already written" answerable. */
export const sig = (l: Line) => [l.driver, l.start, l.end].join("\u0000");

/** Minutes a line is on duty, as inclusive blocks. Mirrors the engine: a blank
 *  window is all day, the window is half-open so the start minute belongs to the
 *  OUTGOING rule, and a start after the end wraps past midnight. */
export function blocks(l: Line): Array<[number, number]> {
  const a = toMin(l.start), b = toMin(l.end);
  if (a < 0 || b < 0) return [[0, 1439]];
  if (a === b) return [];
  return a < b ? [[a + 1, b]] : [[a + 1, 1439], [0, b]];
}

/**
 * The first pair of lines that would be on duty at the same minute, if any.
 *
 * Checked over the branch as a WHOLE rather than field by field, which is the
 * point of editing it as a whole: moving one boundary is only safe in the
 * context of everything beside it, and two rules live at the same minute make
 * the engine refuse the job outright.
 */
export function findClash(lines: Line[]): [Line, Line] | null {
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      for (const x of blocks(lines[i])) {
        for (const y of blocks(lines[j])) {
          if (Math.max(x[0], y[0]) <= Math.min(x[1], y[1])) return [lines[i], lines[j]];
        }
      }
    }
  }
  return null;
}

export const fromMin = (m: number) => {
  const x = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
};

/** One neighbouring rule that could be stretched to swallow the hole, and the
 *  window it would end up with. */
export interface Stretch {
  row: number;
  driver: string;
  edge: "start" | "end";
  /** The time to write into that edge. */
  value: string;
  /** The whole window afterwards, for the button to state plainly. */
  window: string;
}

/**
 * The ways this gap could be closed by moving ONE boundary, already checked
 * against the rest of the branch.
 *
 * The third fix for a hole, and usually the quickest: when the person either
 * side already works up to it, nobody needs a new rule — one of them just
 * covers a little more. `/api/config/stretch-rule` has existed for this the
 * whole time and nothing ever called it, so every gap went through the full
 * editor instead.
 *
 * The arithmetic mirrors `blocks`: a rule covers (start, end], so extending the
 * rule BEFORE means writing the last uncovered minute into its end, while
 * extending the one AFTER means writing the minute before the first uncovered
 * one into its start. An option is only offered if the branch still has no
 * clash afterwards — the server writes the cell without checking that, and a
 * boundary moved onto a neighbour makes the engine refuse the branch outright.
 */
export function stretchOptions(g: CoverageGap, rules: BranchRule[]): Stretch[] {
  const mins = [g.at, ...(g.also ?? [])].map(toMin).filter((m) => m >= 0).sort((a, b) => a - b);
  if (mins.length === 0) return [];
  const earliest = mins[0], latest = mins[mins.length - 1];
  // A hole that appears to straddle midnight is not one hole for this purpose,
  // and stretching a rule across it would rewrite half the day. Leave it to the
  // editor.
  if (latest - earliest > 720) return [];

  const others = rules.map(asLine);
  const out: Stretch[] = [];

  const consider = (side: { row: number; driver: string; window: string } | null, edge: "start" | "end") => {
    if (!side) return;
    const [from, to] = side.window.split("–");
    if (toMin(from ?? "") < 0 || toMin(to ?? "") < 0) return;
    const value = edge === "end" ? fromMin(latest) : fromMin(earliest - 1);
    const next: Line = {
      key: `row:${side.row}`, row: side.row, driver: side.driver,
      start: edge === "start" ? value : from,
      end: edge === "end" ? value : to,
    };
    if (next.start === next.end) return;                     // would never be on duty
    const rest = others.filter((l) => l.row !== side.row);
    if (findClash([...rest, next])) return;                  // lands on a neighbour
    out.push({ row: side.row, driver: side.driver, edge, value, window: `${next.start}–${next.end}` });
  };

  consider(g.before, "end");
  consider(g.after, "start");
  return out;
}
