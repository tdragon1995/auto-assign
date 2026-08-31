/**
 * Turning an unconfigured pickup into a row a supervisor can finish.
 *
 * WHY. A branch with no line in the config reports "chưa cấu hình" on every job
 * it sends, and someone then has to open the workbook, find the end of a
 * 1,700-row table, and type the place name by hand. The engine already knows the
 * branch, where the trip was going, and what time it happened — everything except
 * who should drive it. So it writes that much and leaves the one genuinely human
 * decision blank.
 *
 * WHAT IT DELIBERATELY DOES NOT WRITE. No driver. A row with no driver is dropped
 * when the config is parsed, so a half-finished line cannot route anything, cannot
 * clash with the branch's other rules, and cannot be picked up by mistake. It is
 * inert until a person fills it in — which is the property that makes writing to
 * the live config sheet safe at all.
 *
 * Pure: dates and strings in, cell values out, no network. The sheet mechanics
 * live in `sheets-writer.ts`, which knows the far more dangerous half — that the
 * id columns are one spilling ARRAYFORMULA each and must never be written to.
 */

import { vnHoursMinutes } from "./time";
import { DIAG_LOCATIONS } from "./diag-locations";

export interface UnmappedBranch {
  /** Cartrack customer id of the pickup. Identity for de-duplication only; it is
   *  never written, because the sheet derives it from the name. */
  customer_id: string;
  /** Exactly as Cartrack spells it — it has to match the Location Table for the
   *  workbook's own lookup to resolve it back into an id. */
  pickup_name: string;
  /** Where this particular job was going, or "" when the job has no dropoff. */
  dropoff_name: string;
  /** When the unassignable job was due. Becomes the suggested shift window. */
  at: Date;
}

const HHMM = (mins: number) => {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/**
 * The hour block containing the job, as a window that actually covers it.
 *
 * The subtlety is the boundary. A shift window in this system is half-open — the
 * start minute belongs to the OUTGOING rule, so a job at exactly 10:00 is not
 * covered by a window starting at 10:00. Rounding the job time down to the hour
 * would therefore produce a window that excludes the very job that caused it,
 * for every job that falls on the hour. Backing off a minute before rounding
 * fixes that and changes nothing anywhere else:
 *
 *   09:15 → 09:00–10:00   (covers 09:15)
 *   10:00 → 09:00–10:00   (covers 10:00, where 10:00–11:00 would not)
 *
 * A suggestion, not a rule: it is only a hint about when this branch needs
 * collecting, and it cannot take effect until someone puts a driver beside it.
 */
export function shiftWindowForJob(at: Date): { start: string; end: string } {
  const { hours, minutes } = vnHoursMinutes(at);
  const startHour = Math.floor((hours * 60 + minutes - 1) / 60) * 60;
  return { start: HHMM(startHour), end: HHMM(startHour + 60) };
}

/**
 * A leading `=`, `+` or `@` would be read as a formula rather than a name once
 * the cell is entered the way a person would type it. No Cartrack customer is
 * spelled that way, but the cost of being wrong is a broken cell in the table
 * that feeds every lookup, so it is not left to chance.
 */
function safeCell(v: string): string {
  const s = v.trim();
  return /^[=+@]/.test(s) ? `'${s}` : s;
}

/**
 * What a new config line SAYS, independent of where the columns happen to sit.
 *
 * Deliberately not a positional array any more: the weekday and Sunday tabs have
 * different layouts — different column for the pickup, no destination column at
 * all on Sunday, and a Driver column that is a formula there rather than a value.
 * A shared array of cells would have to be right for both, and silently would not
 * be. The writer maps these four facts onto whichever tab it is writing to.
 */
export interface ConfigCells {
  pickup: string;
  /** Where the trip was going. Written only on a tab that has a column MATCHING
   *  a destination. Never written into an alternate-destination column, which
   *  REWRITES a job's destination rather than matching it. */
  dropoff: string;
  start: string;
  end: string;
}

export function configCellsFor(b: UnmappedBranch): ConfigCells {
  const { start, end } = shiftWindowForJob(b.at);
  return { pickup: safeCell(b.pickup_name), dropoff: safeCell(b.dropoff_name), start, end };
}

/**
 * One row per BRANCH, not per job: a branch that sent five unassignable trips
 * needs one line, not five. The earliest job wins the suggested window, since
 * that is the start of the stretch the branch was uncovered.
 */
/**
 * A pickup that is one of Diag's OWN locations — D001 → D007, D032 → D007,
 * D027 → D001 and the like.
 *
 * These are internal transfers between the lab and its own PSCs, not client
 * collections, and they are not configured with a customer→driver rule. Left in,
 * they sit in the to-do list forever asking to be given a driver rule that they
 * are never going to get.
 *
 * Matched on the customer id, not the name: the id is what the job carries and
 * what never changes, whereas "BRA - D001" is a label that a rename would break —
 * the same trap that started this whole piece of work.
 */
function isOwnLocation(customerId: string, pickupName: string): boolean {
  const id = customerId.trim();
  const name = pickupName.trim();
  return DIAG_LOCATIONS.some((l) => l.customer_id === id || (!!name && l.customer_name === name));
}

export function dedupeBranches(found: readonly UnmappedBranch[]): UnmappedBranch[] {
  const first = new Map<string, UnmappedBranch>();
  for (const b of found) {
    if (!b.customer_id || !b.pickup_name) continue;   // nothing useful to write
    if (isOwnLocation(b.customer_id, b.pickup_name)) continue;   // an internal leg, not a client
    const prev = first.get(b.customer_id);
    if (!prev || b.at < prev.at) first.set(b.customer_id, b);
  }
  return [...first.values()];
}

// ── Writing them ─────────────────────────────────────────────────────────────

/**
 * Append a config line for every branch that turned out to have none.
 *
 * Runs at the end of a cycle, and is never allowed to affect it: a sheet that
 * refuses the write, a revoked service account, a Google outage — all of them
 * cost a log line and nothing else. Assignment has already happened by this
 * point; this is paperwork.
 *
 * The config cache is deliberately NOT invalidated afterwards. The new row has no
 * driver, so re-reading the sheet would find nothing the engine can use, while
 * costing every server on both deployments a fresh download of the whole table.
 * The row matters when a person fills it in, and pressing Refresh is part of
 * doing that.
 */
export async function writeUnmappedConfigRows(
  found: readonly UnmappedBranch[],
  log: (msg: string, level?: "OK" | "INFO" | "WARN" | "ERROR") => void,
): Promise<void> {
  const branches = dedupeBranches(found);
  if (branches.length === 0) return;

  const kv = await import("./smart-log-kv");
  // Taken BEFORE the per-branch claims, not after: a branch marked as written by
  // a run that then failed to get the lock would never be written by anyone.
  if (!(await kv.acquireConfigWriteLock())) return;

  try {
    const mine: UnmappedBranch[] = [];
    for (const b of branches) {
      if (await kv.claimUnmappedConfigRow(b.customer_id)) mine.push(b);
    }
    if (mine.length === 0) return;

    const { writeConfigRows } = await import("./sheets-writer");
    const at = await writeConfigRows(mine.map(configCellsFor));
    mine.forEach((b, i) => {
      const { start, end } = shiftWindowForJob(b.at);
      // The row NUMBER is the useful part of this line: it is what turns "go and
      // configure this branch" into "open the sheet at row 1751".
      log(`Đã thêm dòng config ${at[i]} cho ${b.pickup_name} (${start}–${end}) — cần chọn tài xế | ${b.pickup_name} → ${b.dropoff_name || "—"}`, "WARN");
    });
  } catch (e) {
    log(`Không ghi được dòng config cho điểm chưa cấu hình: ${e}`, "WARN");
  } finally {
    await kv.releaseConfigWriteLock();
  }
}
