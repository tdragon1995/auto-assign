/**
 * Working out which driver a typed name means.
 *
 * WHY THIS EXISTS. The workbook resolves names to ids with a spreadsheet lookup
 * against the roster tab — and that tab's name column is rebuilt verbatim from
 * Cartrack on every fetch. So when a driver's name is corrected in Cartrack,
 * every row elsewhere that was typed against the old spelling stops resolving.
 * The lookups are wrapped, so they return BLANK rather than an error, and a leave
 * row with a blank id is invisible: the engine goes on handing work to someone
 * who is off.
 *
 * This is the stopgap for that, and it is deliberately timid. It will only speak
 * up when there is exactly ONE working driver it could possibly mean. Two
 * candidates, or none, and it says so and changes nothing — because the
 * alternative is silently moving a day's work onto the wrong person off the back
 * of a cell that is already known to be wrong.
 *
 * The ambiguous case is real and common: roughly a dozen drivers hold BOTH a
 * part-time and a full-time account under the same personal name. A bare name
 * matches both, and which one the leave belongs to is genuinely unknowable from
 * the row, so those are never recovered.
 *
 * Pure string work over a roster passed in — no fetching, no caching, no imports
 * beyond the display helpers, so it can be exercised directly by a test.
 *
 * Step 4 of the config plan deletes this: once leave is entered through a form
 * that stores the driver's identity, there is no name left to re-resolve.
 */

import { driverDisplayName, staffCode } from "./display-names";

export interface RosterEntry {
  driver_id: string;
  /** The roster's display name, e.g. "F - C - DC100320 Lý Chánh Hùng". */
  name: string;
}

export type NameMatch =
  | { status: "unique"; driver_id: string; matched_name: string; via: "code" | "name" }
  | { status: "none" }
  | { status: "ambiguous"; count: number };

/**
 * Reduce a name to what two people typing the same person would agree on:
 * no staff code, no accents, no case, no repeated spaces.
 *
 * `đ` is handled on its own line because it is a distinct Vietnamese letter, not
 * a `d` with a mark — Unicode decomposition leaves it exactly as it was, so
 * without this "Đoàn" and "Doan" would never meet.
 */
export function normalizeDriverName(raw: string | null | undefined): string {
  if (!raw) return "";
  return driverDisplayName(raw)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Which driver `typed` means, given the roster of drivers who can actually work.
 *
 * The staff code is tried first because it is the part of a label that SURVIVES a
 * rename — it is assigned by payroll, not derived from how the person's name is
 * spelled. A label carrying a code that matches nobody falls through to the name
 * rather than giving up: the code may simply predate the roster.
 *
 * Pass only drivers who are able to take work. A deactivated account matching a
 * name would be worse than no match at all.
 */
export function matchDriverByName(
  typed: string | null | undefined,
  roster: readonly RosterEntry[],
): NameMatch {
  if (!typed || !typed.trim()) return { status: "none" };

  const code = staffCode(typed);
  if (code) {
    const byCode = roster.filter((r) => staffCode(r.name) === code);
    if (byCode.length === 1) {
      return { status: "unique", driver_id: byCode[0].driver_id, matched_name: byCode[0].name, via: "code" };
    }
    if (byCode.length > 1) return { status: "ambiguous", count: byCode.length };
  }

  const want = normalizeDriverName(typed);
  if (!want) return { status: "none" };

  const byName = roster.filter((r) => normalizeDriverName(r.name) === want);
  if (byName.length === 1) {
    return { status: "unique", driver_id: byName[0].driver_id, matched_name: byName[0].name, via: "name" };
  }
  if (byName.length > 1) return { status: "ambiguous", count: byName.length };

  return { status: "none" };
}
