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
