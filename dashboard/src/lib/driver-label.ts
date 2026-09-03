import { driverDisplayName, staffCode } from "./display-names";

/**
 * Reading and ordering a driver's sheet label.
 *
 * Labels arrive as "F - C - DC100320 Lý Chánh Hùng": employment type, area,
 * staff code, then the person. Everything before the name is routing metadata
 * that matters to payroll and to nobody scanning a list, but it sorts FIRST —
 * so an untouched list orders by employment type and area, which is to say not
 * by anything a supervisor is looking for.
 *
 * Ordering on the personal name has a second effect that is the point rather
 * than a side effect: roughly a dozen people hold BOTH a full-time `DC…` and a
 * part-time `PT…` account, and since the MISA sync began filing a day off
 * against the twin as well, both accounts appear on the same day. Sorting by the
 * person puts those two rows next to each other instead of at opposite ends of
 * the list, which is the closest thing to grouping them that keeps each row
 * separately actionable — they are separate records with separate substitutes,
 * and merging them into one card would hide which account a substitute covers.
 */

/**
 * "F - C - DC100320 Lý Chánh Hùng" → code "DC100320", name "Lý Chánh Hùng".
 *
 * The employment/area prefix is dropped entirely. It is routing metadata for the
 * Cartrack record — it says nothing a person reading a list needs, it is the
 * widest thing on the row, and on a phone it was pushing the actual content off
 * the edge. What survives is the staff code, which is the part that identifies
 * the ACCOUNT: about a dozen people hold two of them under one personal name, so
 * without it those rows are indistinguishable.
 *
 * Built on `driverDisplayName` / `staffCode` rather than its own split, so there
 * is one definition of how a label comes apart and this cannot drift from the
 * TAT panels, the name matcher, or the driver's own app.
 */
export function splitDriverName(full: string): { code: string | null; name: string } {
  return { code: staffCode(full) || null, name: driverDisplayName(full) || full };
}

/**
 * Order two sheet labels by the person, then by their account.
 *
 * Compared in the `vi` locale, not by code point: Vietnamese orders the vowels
 * with their diacritics ("Ả" belongs with "A", not after "Z"), and a default
 * comparison scatters half the roster. The staff code breaks a tie so a person's
 * two accounts keep a stable order between renders rather than swapping places
 * whenever the sheet is re-read.
 */
export function compareDriverNames(a: string, b: string): number {
  const A = splitDriverName(a || "");
  const B = splitDriverName(b || "");
  return (
    A.name.localeCompare(B.name, "vi") ||
    (A.code ?? "").localeCompare(B.code ?? "", "vi")
  );
}

/** Order by person first, then by an already-formatted "HH:MM–HH:MM" window, so
 *  one driver's split shift reads morning-before-afternoon. A full-day row (no
 *  window) sorts ahead of any windowed one. */
export function compareByDriverThenWindow(
  a: { driver_name: string; timeLabel: string | null },
  b: { driver_name: string; timeLabel: string | null },
): number {
  return (
    compareDriverNames(a.driver_name, b.driver_name) ||
    (a.timeLabel ?? "").localeCompare(b.timeLabel ?? "")
  );
}

/**
 * Which kind of account a label names.
 *
 * The staff code carries it: `DC…` is full-time, `PT…` is part-time. It is the
 * one part of a label that survives a rename — payroll assigns it, it is not
 * derived from how the person's name is spelled — so it is the right thing to
 * read this off.
 *
 * Case-SENSITIVE, deliberately, for the same reason `staffCode` in
 * display-names.ts is: staff codes are upper case, and a case-insensitive match
 * would let an ordinary lower-case "dc" or "pt" inside a Vietnamese name be read
 * as an employment type. Matched with a word boundary and any following run of
 * capitals and digits, so the relief drivers' `DCBU` / `PTBU` — no digits at all
 * — classify correctly rather than falling through as unknown.
 *
 * Returns null when there is no code to read. That is a real case, not a
 * fallback: "Admin Lý Thị Thùy Linh" is neither, and guessing would be worse
 * than showing nothing.
 */
export type Employment = "full-time" | "part-time";

export function employmentOf(full: string | null | undefined): Employment | null {
  const m = full ? /\b(PT|DC)[A-Z0-9]*/.exec(full) : null;
  if (!m) return null;
  return m[1] === "PT" ? "part-time" : "full-time";
}

/**
 * What the chip says. Two letters, not two words.
 *
 * These sit on a row that already carries a name, a leave type, an hour window
 * and up to two buttons; spelled-out Vietnamese pushed that past the width of a
 * phone. FT/PT is not shorthand invented here either — the completed-jobs export
 * has carried an "FT/PT" column for as long as it has existed, so this is the
 * word the team already uses.
 *
 * Note FT, not DC: DC is the payroll prefix on the account, FT is what the
 * account IS. The prefix stays visible in the staff code beside it.
 */
export const EMPLOYMENT_LABEL: Record<Employment, string> = {
  "full-time": "FT",
  "part-time": "PT",
};

/** The long form, for the chip's tooltip — two letters need somewhere to be
 *  explained, and that somewhere costs no width. */
export const EMPLOYMENT_TITLE: Record<Employment, string> = {
  "full-time": "FT — toàn thời gian (tài khoản DC)",
  "part-time":
    "PT — bán thời gian: tài xế chuyển sang tài khoản này cho chuyến chạy quá ca chính",
};
