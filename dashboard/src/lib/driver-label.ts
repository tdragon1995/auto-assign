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
