/**
 * Whether a day off reaches someone's PART-TIME account.
 *
 * About a dozen people hold both a `DC…` full-time and a `PT…` part-time
 * account and switch to the second for a trip running past their own shift. A
 * day off filed against only the full-time account leaves the twin reading as
 * available, so both writers — the MISA sync and the dashboard's leave form —
 * offer a second row for the twin.
 *
 * THE QUESTION IS ANSWERED HERE, ONCE, ON THE SERVER, because it needs the
 * CONFIG and neither writer can see it: the MISA sync is a GitHub Action and the
 * leave form is a browser. `/api/nghi-phep` is the one door both go through, so
 * a companion row arrives flagged (`pt_companion`) and is gated here.
 *
 * WHAT IT USED TO DO, AND WHY THAT WAS WRONG. The rule was a clock: a half-day
 * ending after noon reached the twin, one ending before it did not. That reads
 * the wrong thing. A supervisor typing 06:00–13:00 means "off this morning, back
 * at one" — the person works the afternoon AND the evening — and the noon rule
 * filed the twin off from 06:00 to 23:59, marking a working evening as absent.
 * It also failed the other way: a PT account rostered 06:00–10:00 got no row for
 * a morning absence that plainly covers it.
 *
 * WHAT DECIDES NOW IS THE CONFIG. The twin only needs a day off where the twin
 * has work to miss:
 *
 *   - A WHOLE DAY reaches the twin when the twin is in the config at all. There
 *     is no window to compare against; if that account is rostered anywhere, a
 *     day away from it is a day it cannot work.
 *   - A HALF DAY reaches the twin only where the ORIGINAL window overlaps a
 *     window the twin is actually on duty for. 06:00–13:00 against an evening
 *     rule touches nothing, so nothing is filed.
 *
 * The comparison is by the HOUR. A minute must not decide it: shift boundaries
 * are hand-typed and drift between rows for the same person, and a rule that
 * answers differently for 16:59 and 17:00 is one nobody can predict.
 *
 * "In the config" counts BOTH a fixed `driver_id` and membership of a
 * `smart_driver_id` list. A smart row is not a weaker claim on the account: it
 * is exactly the list smart-assign ranks, so an account left looking available
 * there is one the engine can still pick.
 *
 * Duty minutes come from `dutyBlocks`, the same function the config audit uses,
 * so a blank shift (all day), an overnight wrap and the exclusive-start
 * convention are read here exactly as the engine reads them rather than
 * approximated a second time.
 */
import type { Mapping } from "./types";
import { dutyBlocks } from "./config-audit";

/** Inclusive minute ranges, midnight-based. */
export type Block = [number, number];

/** `"13:30"` → 810; -1 for anything unparseable. */
function toMin(t: string | null | undefined): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((t ?? "").trim());
  if (!m) return -1;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins < 24 * 60 ? mins : -1;
}

/**
 * Every minute this driver is on duty somewhere in the config.
 *
 * Not merged or sorted: the only question asked of them is whether ANY of them
 * meets a window, so the cost of tidying them would buy nothing.
 */
export function configDutyBlocks(driverId: string, mappings: readonly Mapping[]): Block[] {
  const id = (driverId ?? "").trim();
  if (!id) return [];
  const blocks: Block[] = [];
  for (const m of mappings) {
    const fixed = m.driver_id === id;
    const smart = m.smart_driver_id?.includes(id) ?? false;
    if (!fixed && !smart) continue;
    blocks.push(...dutyBlocks(m));
  }
  return blocks;
}

/**
 * Does this day off reach an account rostered for `blocks`?
 *
 * `window` is the ORIGINAL leave window — the one the person actually asked
 * for. Never the companion's own rewritten hours: those run to the end of the
 * day, so testing them would overlap every evening rule and answer yes to
 * everything, which is the bug this function replaces.
 */
export function companionNeeded(
  window: { start: string; end: string } | null,
  blocks: readonly Block[],
): boolean {
  if (blocks.length === 0) return false;
  if (!window) return true; // whole day: rostered anywhere is enough

  const from = toMin(window.start);
  const to = toMin(window.end);
  // An unusable window is not a reason to guess. The engine ignores such a leave
  // row anyway, so filing the twin off on it would make the twin MORE absent
  // than the person it copies.
  if (from < 0 || to <= from) return false;

  // Compared by the HOUR, not the minute.
  //
  // A single minute must not decide this. Leaving at 13:00 against a rule that
  // starts at 17:00 is not meaningfully different from leaving at 13:00 against
  // one that starts at 16:59, and a rule that answers differently for the two is
  // one nobody can predict from looking at a roster. Shift boundaries are also
  // typed by hand and drift by a few minutes between rows for the same person.
  //
  // So both sides collapse to the hours they touch and the question becomes
  // whether they share one. It is deliberately the FORGIVING direction: the
  // companion is a whole day off, and being an hour generous about triggering
  // one costs less than missing an evening the person is not there for.
  const hours = ([s, e]: readonly [number, number]): [number, number] =>
    [Math.floor(s / 60), Math.floor(e / 60)];
  const [lf, lt] = hours([from, to]);
  return blocks.some((b) => {
    const [bf, bt] = hours(b);
    return Math.max(bf, lf) <= Math.min(bt, lt);
  });
}
