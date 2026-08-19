/**
 * Turning Cartrack's record names into something a person wants to read.
 *
 * Both names in this file arrive carrying routing metadata that mattered to
 * whoever set the record up and matters to nobody looking at a report. Pure
 * string work, no imports — this is used from client components and server
 * routes alike, so it must not drag anything with it.
 */

/**
 * "F - C - DC100320 Lý Chánh Hùng" → "Lý Chánh Hùng"
 *
 * The prefix is employment type, area, then the staff code. The old rule matched
 * `(PT|DC)\d+` and so missed every relief driver, whose code is `DCBU` / `PTBU`
 * with no digits at all — those names showed up in full, staff code and all,
 * which is exactly the person least likely to know why. Matching the code as
 * "PT or DC followed by any run of capitals and digits" covers `DC100320`,
 * `DCBU` and the `DC100XXX` proxy account in one rule.
 *
 * Deliberately case-SENSITIVE. Staff codes are always upper case, and a
 * case-insensitive match would let an ordinary lower-case "dc" or "pt" inside a
 * Vietnamese name start eating the name itself.
 *
 * A name with no staff code at all ("Admin Lý Thị Thùy Linh") is returned
 * untouched rather than guessed at.
 */
export function driverDisplayName(full: string | null | undefined): string {
  if (!full) return "";
  return full.replace(/^.*?\b(?:PT|DC)[A-Z0-9]*\s+/, "").trim() || full.trim();
}

/**
 * "F - C - DC100320 Lý Chánh Hùng" → "DC100320", or "" when there is no code.
 *
 * Needed wherever a list can hold two rows for the same person. Roughly a dozen
 * drivers run BOTH a part-time (`PT…`) and a full-time (`DC…`) account — same
 * human, same personal name, two separate records with separate histories — so a
 * ranked table showing trimmed names alone would print "Nguyễn Hồng Sơn" twice
 * with different numbers and no way to tell which is which.
 */
export function staffCode(full: string | null | undefined): string {
  const m = full ? /\b(?:PT|DC)[A-Z0-9]*/.exec(full) : null;
  return m ? m[0] : "";
}

/**
 * "BRA - D001" → "D001", "SENDOUT2 - D10 - HHao - MEDIC" → "MEDIC".
 *
 * Customer names are built as a path — record type, then zone, then finally the
 * place. Only the last part names somewhere a driver has ever stood, and on a
 * phone the prefix is what pushes the actual destination off the edge of the row.
 *
 * Splits on a SPACED hyphen. Vietnamese place names contain bare hyphens
 * ("Bà Rịa - Vũng Tàu" is spaced, but "Ð-Ward" style compounds are not), and
 * splitting on every "-" would cut those in half.
 */
export function placeName(name: string | null | undefined): string {
  if (!name) return "";
  const parts = name.split(/\s+-\s+/).filter((p) => p.trim() !== "");
  return (parts.length > 0 ? parts[parts.length - 1] : name).trim();
}
