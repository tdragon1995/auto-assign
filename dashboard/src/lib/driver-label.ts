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
 * "F - C - DC100320 Lý Chánh Hùng" → code "F - C - DC100320", name "Lý Chánh Hùng".
 *
 * The code keeps its prefix because that is what a supervisor recognises the
 * account by — it is rendered beside the name, de-emphasised. A label not
 * following the "A - B - CODE Name" shape is returned whole rather than guessed
 * at, so an "Admin …" row still reads correctly.
 */
export function splitDriverName(full: string): { code: string | null; name: string } {
  const parts = full.split(" - ");
  if (parts.length >= 3) {
    const tail = parts[parts.length - 1]; // "DC100320 Lý Chánh Hùng"
    const sp = tail.indexOf(" ");
    if (sp > 0) {
      return {
        code: [...parts.slice(0, -1), tail.slice(0, sp)].join(" - "),
        name: tail.slice(sp + 1),
      };
    }
  }
  return { code: null, name: full };
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

/** What to call it on screen. Vietnamese, because the panel is. */
export const EMPLOYMENT_LABEL: Record<Employment, string> = {
  "full-time": "Toàn thời gian",
  "part-time": "Bán thời gian",
};
