/**
 * Comparing driver names the way two people typing the same person would.
 */

import { driverDisplayName } from "./display-names";

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
