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
  /**
   * The destination NAME this line answers for; "" is every destination.
   *
   * Set when the line is created and never edited here. A line being ADDED
   * carries it into the sheet; a line that already has a row cannot change it,
   * because the only write that touches an existing row is `completeConfigRow`
   * and it deliberately names no destination column. So this is what the rule
   * IS, not a field being offered — but it has to be on the line, because the
   * clash check cannot be right without it.
   */
  dropoff: string;
}

let newLineSeq = 0;
export const newLineKey = () => `new:${++newLineSeq}`;

export const asLine = (r: BranchRule): Line => ({
  key: `row:${r.row}`, row: r.row, driver: r.driver, start: r.start, end: r.end,
  dropoff: r.dropoff ?? "",
});

/**
 * Whether two lines are answering for the same destination, and so can collide.
 *
 * The engine never compares a branch's rules as one flat list. For a job going
 * to D it keeps the rows scoped to D if there are any, and otherwise the blank
 * rows, and only then counts how many are on duty (`mappingsForRoute` +
 * `preferDestinationRows` in fixed-driver.ts). Two rules can therefore sit on
 * the same minute quite safely, as long as they answer for different places:
 *
 *   • blank vs "Lab Trung Tâm" — for that lab the scoped row REPLACES the blank
 *     one, and everywhere else the scoped row is dropped. One row either way.
 *   • "Lab A" vs "Lab B" — neither is ever in the other's candidate set.
 *   • blank vs blank, or one destination named twice — one set, two rows, CLASH.
 *
 * Compared by NAME because that is what the editor holds and writes; the sheet
 * derives the id from it, so two spellings of one place would read as two
 * destinations here. Folded for case and spacing to take the edge off that, and
 * it errs the safe way regardless: a name typed two ways looks like two scopes,
 * which lets through a pair the offline audit then reports as an overlap —
 * whereas the opposite mistake would refuse a roster that is actually fine.
 *
 * The same rule that audit already applies (`config-audit.ts` skips a pair whose
 * `dropoff_id` differs), stated here against names.
 */
export const sameScope = (a: Line, b: Line) =>
  a.dropoff.trim().toLowerCase() === b.dropoff.trim().toLowerCase();

/** What a line would WRITE. Two lines with the same signature put the same
 *  content in the sheet, which is what makes "already written" answerable. */
export const sig = (l: Line) => [l.driver, l.start, l.end, l.dropoff].join("\u0000");

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
 *
 * "At the same minute" is not enough on its own — the pair also has to be
 * answering for the same destination, or the engine never has both in hand at
 * once. See `sameScope`. Every rule this branch had before the destination
 * column existed is blank, so on those branches this is the check it always was.
 */
export function findClash(lines: Line[]): [Line, Line] | null {
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (!sameScope(lines[i], lines[j])) continue;
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
      // A stretch moves one boundary and nothing else, so the rule keeps the
      // destination it already answered for. Taken from the branch's own rules
      // rather than defaulted to blank: defaulting would make a scoped rule look
      // branch-wide, and the clash check below would then refuse a stretch that
      // is perfectly safe (or, on the other side, offer one that is not).
      dropoff: others.find((l) => l.row === side.row)?.dropoff ?? "",
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

/** Every minute of the day some line is on duty. Used to prove a boundary move
 *  does not quietly hand back coverage somewhere else. */
function coveredMinutes(lines: readonly Line[]): boolean[] {
  const on = new Array<boolean>(1440).fill(false);
  for (const l of lines) {
    for (const [a, b] of blocks(l)) {
      for (let m = a; m <= b; m++) on[m] = true;
    }
  }
  return on;
}

/**
 * The ways an OVERLAP could be closed by moving ONE boundary — the mirror of
 * {@link stretchOptions}, and the reason an overlap can be a to-do rather than a
 * paragraph in a banner.
 *
 * Two fixed rules live at the same minute make the engine refuse the job with
 * CLASH, which is the "Trùng tài xế trực" list on the same dashboard. The fix is
 * the same shape as closing a hole, in the opposite direction: either the
 * earlier rule hands over sooner, or the later one starts later. Both are one
 * cell, and `/api/config/stretch-rule` already writes exactly that.
 *
 * TWO guards, and the second is the one that matters:
 *
 *   - the result must not clash with anything else on the branch — the same
 *     check the gap direction makes, because the server writes the cell without
 *     looking at its neighbours;
 *   - the result must not UNCOVER a minute that is covered today. Without this,
 *     a rule wholly containing another (05:00–20:00 around 08:00–12:00) would be
 *     "fixed" by cutting the outer one down to 05:00–08:00, silently trading a
 *     clash for a five-hour hole — and a hole is the worse fault, since the
 *     engine refuses those jobs too but nothing in the sheet says why. Where
 *     neither move survives, nothing is offered and the branch goes to the full
 *     editor, which shows the whole day at once.
 */
export function shrinkOptions(
  sides: readonly [{ row: number; driver: string; window: string }, { row: number; driver: string; window: string }],
  rules: BranchRule[],
): Stretch[] {
  const [first, second] = sides;
  const parse = (w: string): [string, string] | null => {
    const [f, t] = (w ?? "").split("–");
    return toMin(f ?? "") >= 0 && toMin(t ?? "") >= 0 ? [f, t] : null;
  };
  const fw = parse(first.window);
  const sw = parse(second.window);
  // A rule with no window is on duty all day; there is no single boundary that
  // makes it stop competing, so the editor owns that case.
  if (!fw || !sw) return [];

  const all = rules.map(asLine);
  const before = coveredMinutes(all);
  const out: Stretch[] = [];

  const consider = (side: { row: number; driver: string }, edge: "start" | "end", value: string) => {
    const own = fw && side.row === first.row ? fw : sw;
    const next: Line = {
      key: `row:${side.row}`, row: side.row, driver: side.driver,
      start: edge === "start" ? value : own[0],
      end: edge === "end" ? value : own[1],
      /** Same as in `stretchOptions`: a boundary move keeps the rule's scope. */
      dropoff: all.find((l) => l.row === side.row)?.dropoff ?? "",
    };
    if (next.start === next.end) return;                  // on duty for no minute
    const rest = all.filter((l) => l.row !== side.row);
    const after = [...rest, next];
    if (findClash(after)) return;                         // still competing with someone
    const cover = coveredMinutes(after);
    for (let m = 0; m < 1440; m++) if (before[m] && !cover[m]) return;  // opened a hole
    out.push({ row: side.row, driver: side.driver, edge, value, window: `${next.start}–${next.end}` });
  };

  // The earlier rule hands over where the later one begins…
  consider(first, "end", sw[0]);
  // …or the later one starts where the earlier one ends.
  consider(second, "start", fw[1]);
  return out;
}

/** Stable identity for one overlapping pair, so the dashboard can remember that
 *  it was dealt with. Built from the branch and the two ROWS rather than the
 *  drivers or the window: fixing it changes the window and may change who is on
 *  which side, and a key that moved would make the row reappear as new. */
export function overlapKey(o: { customer_id: string; rules?: readonly [{ row: number }, { row: number }] }): string {
  const rows = o.rules ? [o.rules[0].row, o.rules[1].row].sort((a, b) => a - b).join("-") : "?";
  return `${o.customer_id}|${rows}`;
}

/**
 * The stretch that would stop being covered if one row were removed, or null.
 *
 * The delete button needed this and did not have it, which made the two sides of
 * an overlap look interchangeable when they are not. Live pair, 2026-09-03: one
 * branch with 07:00–16:00 and 07:00–16:30 for the same driver — removing the
 * first changes nothing, removing the second silently gives up 16:00–16:30, and
 * both buttons read the same.
 *
 * `shrinkOptions` has refused to open a hole since it was written; a delete can
 * legitimately want to shed cover, so this reports rather than refuses. But it
 * has to be SAID, because a gap is the fault the engine reports as NO_DRIVER and
 * the one thing the sheet itself never explains.
 *
 * Reported in the sheet's own half-open terms — the label is the window a rule
 * would need in order to cover it again.
 */
export function coverageLostWithout(rules: BranchRule[], row: number): string | null {
  const all = rules.map(asLine);
  if (!all.some((l) => l.row === row)) return null;
  const before = coveredMinutes(all);
  const after = coveredMinutes(all.filter((l) => l.row !== row));
  const lost: number[] = [];
  for (let m = 0; m < 1440; m++) if (before[m] && !after[m]) lost.push(m);
  if (lost.length === 0) return null;
  // One label covering first to last: a removed rule's cover is contiguous in
  // every real case, and a spanning label still names the right thing to look at.
  return `${fromMin(lost[0] - 1)}–${fromMin(lost[lost.length - 1])}`;
}

/**
 * How a copied rule is matched against what the editor already holds.
 *
 * Shared with the picker rather than written twice: the picker uses it to say
 * how many rules a branch would actually ADD, and `applyCopiedLines` uses it to
 * decide which ones to add. Two spellings of that question would eventually
 * disagree, and the disagreement would show as a button promising a number the
 * copy then did not deliver — the exact defect the count was added to fix.
 *
 * The destination is part of the identity: the same driver on the same hours
 * answering for a different place is a different rule, not a duplicate. Folded
 * for case, like `sameScope`, so the two agree about what one place is.
 */
export const copyKey = (driver: string, start: string, end: string, dropoff: string) =>
  `${driver.trim()}|${start.trim()}|${end.trim()}|${dropoff.trim().toLowerCase()}`;

/** A rule as the copy picker hands it over: what to write, with no row yet. */
export interface CopiedLine {
  driver: string;
  start: string;
  end: string;
  dropoff: string;
}

/**
 * Fold copied rules into the branch being edited, filling EMPTY SHEET ROWS first.
 *
 * The copy used to append, always, beside whatever the editor already held. That
 * is wrong in the one place the button matters most. The editor is usually
 * opened FROM an unfinished row — a row this system created, carrying a window
 * and no driver, which is the whole reason the branch is in the to-do list — and
 * appending beside it leaves that row exactly as it was. The save then refuses
 * on it ("Chưa chọn tài xế") and the copy cannot be written at all; name a
 * driver on it by hand and its old window usually sits inside the copied one, so
 * it becomes a CLASH instead. Either way the button did not work on the row it
 * was built for.
 *
 * An empty row is not something to preserve. It is reserved capacity — the sheet
 * is finite, and `writeConfigRows` refuses once the table is full — so the first
 * copied rule takes it over, driver and hours together, and only what is left
 * over is appended as new. The row number rides along, which is what makes the
 * save an UPDATE of that row rather than an append beside it, so the to-do row
 * that opened the editor is the row that gets answered.
 *
 * What an adopted row does NOT take from the copy is its DESTINATION. The write
 * that fills an existing row (`completeConfigRow`) names no destination column,
 * deliberately, so the row keeps the scope the sheet already has for it —
 * showing the copied one would be the form claiming a write it cannot make, and
 * would put the clash check on the wrong footing too. A rule appended as new is
 * free to carry the copied scope, because that one is genuinely being created.
 *
 * Lines that already name a driver are never touched: they are real rules, and
 * one the supervisor has half-filled is work in progress, not free space.
 */
export function applyCopiedLines(
  lines: readonly Line[],
  copied: readonly CopiedLine[],
): { lines: Line[]; touched: string[] } {
  // A blank line nobody has touched is a placeholder, not a rule — drop it
  // rather than saving an empty row beside the copy. One with a sheet row stays:
  // it exists in the sheet whether or not this editor keeps it on screen.
  const kept = lines.filter((l) => l.driver.trim() || l.start.trim() || l.end.trim() || l.row);

  // Deduped against the rules that are actually THERE. A slot waiting to be
  // filled names no driver, so it can never match a copied rule anyway.
  const have = new Set(
    kept.filter((l) => l.driver.trim()).map((l) => copyKey(l.driver, l.start, l.end, l.dropoff)),
  );
  const incoming = copied.filter((c) => !have.has(copyKey(c.driver, c.start, c.end, c.dropoff)));

  const slots = kept.filter((l) => l.row && !l.driver.trim()).map((l) => l.key);
  const adopt = new Map<string, CopiedLine>();
  let next = 0;
  for (const c of incoming) {
    if (next < slots.length) adopt.set(slots[next++], c);
  }
  const appended = incoming.slice(next);

  const touched: string[] = [];
  const out = kept.map((l) => {
    const c = adopt.get(l.key);
    if (!c) return l;
    touched.push(l.key);
    // Scope stays the ROW's — see above. Everything else comes from the copy.
    return { ...l, driver: c.driver, start: c.start, end: c.end };
  });
  for (const c of appended) {
    const key = newLineKey();
    touched.push(key);
    out.push({ key, ...c });
  }
  return { lines: out, touched };
}
