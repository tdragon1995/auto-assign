/**
 * Cartrack stores client rows as "{account code} - {old district} - {street abbrev} - {name}"
 * ("46647677 - BTan - 54 - BV QUỐC ÁNH"). Only the trailing name means anything to staff, and
 * the codes are what pushed real names off the edge of a row. Diag's own sites use the shorter
 * "BRA - D010". Anything matching neither shape is left alone rather than guessed at — a client
 * name may legitimately contain " - ".
 *
 * Shared by /qr, /psc-tinh and /ao so the same place reads the same way on every screen.
 */
export function placeLabel(name: string): string {
  return displayClientName(placeCore(name));
}

function placeCore(name: string): string {
  const raw = (name ?? "").trim();
  const parts = raw.split(" - ");
  if (parts.length < 2) return raw;
  if (/^BRA$/i.test(parts[0])) return parts.slice(1).join(" - ");
  // The convention is exactly four segments, so four or more means a client row. Joining the
  // tail rather than taking parts[3] keeps names that contain " - " themselves intact, and the
  // leading code isn't always numeric ("SENDOUT2 - D10 - HHao - MEDIC").
  if (parts.length >= 4) return parts.slice(3).join(" - ");
  // Shorter rows still lead with the account code.
  if (/^\d+$/.test(parts[0])) return parts.slice(1).join(" - ");
  return raw;
}

/** Drops the legal-form prefix ("Công ty cổ phần", "TNHH (MTV)", "CTCP", "Hộ kinh doanh"…) the way
 *  the AO hard copy prints client names. */
export function displayClientName(name: string): string {
  const short = name.replace(/(^|[\s-])(?:công ty\s+(?:cổ phần|tnhh|trách\s+nhiệm\s+hữu\s+hạn)|cty\s+tnhh|ctcp|hộ\s+kinh\s+doanh|doanh\s+nghiệp\s+tư\s+nhân|công\s+tnhh)(?:\s+(?:mtv|một\s+thành\s+viên))?\s+(\S)/iu,
    (_, lead: string, first: string) => lead + first.toLocaleUpperCase("vi")).trim();
  return short.replace(/^\p{L}/u, (first) => first.toLocaleUpperCase("vi"));
}
