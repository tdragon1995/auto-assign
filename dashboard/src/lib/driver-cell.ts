import type { ConfigDriver } from "./types";

/**
 * The config sheet's "Driver" cell — what it may hold, and how a typed one is
 * turned back into something the sheet's own lookup will resolve.
 *
 * Pure and dependency-free so the editor, the two write routes and the tests all
 * apply exactly one rule. It was three separate readings before, and they
 * disagreed on the thing that matters most below.
 */

/**
 * Fold accents so a name typed quickly still matches: "quynh" has to find
 * "Nguyễn Hữu Quỳnh". đ is handled separately — it is a distinct Vietnamese
 * letter, not a d with a mark, so decomposition leaves it untouched.
 */
export const foldName = (v: string) =>
  v.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

/** The separator the id formula beside the cell splits on. */
export const DRIVER_SEP = ", ";

/**
 * The cell, split into the names it holds.
 *
 * ONE name is a fixed rule — that person, that window. SEVERAL, comma-separated,
 * is a SMART row: the id column beside it is a formula that resolves each name in
 * turn, and the engine ranks them by distance and gives the job to whoever is
 * nearest. Roughly 218 rows look like this today.
 *
 * So a cell with commas is not malformed, and reading it as a single name refuses
 * a shape the sheet has always had. That is what the editor did on its first
 * outing: a smart branch could not be opened at all, which meant its HOURS could
 * not be edited either — the multi-driver cell blocked a change that had nothing
 * to do with drivers.
 */
export function splitDriverNames(cell: string): string[] {
  return cell.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Resolve a typed cell against the roster, refusing anything ambiguous.
 *
 * The roster is what the sheet's own lookup resolves against, so a name that is
 * not on it writes perfectly well and then resolves to nothing — a row that looks
 * finished and assigns nobody. Each name is resolved on its own and the cell is
 * rebuilt from the roster's spelling, so what lands in the sheet is what the
 * formula beside it expects to read.
 */
export function resolveDriverCell(
  typed: string,
  drivers: readonly ConfigDriver[],
): { name: string } | { error: string } {
  const parts = splitDriverNames(typed);
  if (parts.length === 0) return { error: "Chưa chọn tài xế" };
  const names: string[] = [];
  for (const part of parts) {
    const q = foldName(part);
    const exact = drivers.filter((d) => foldName(d.name) === q);
    const hits = exact.length ? exact : drivers.filter((d) => foldName(d.name).includes(q));
    // Names the offending PART, not the whole cell — quoting two names back at
    // someone when only the second is wrong tells them nothing about which.
    if (hits.length === 0) return { error: `"${part}" không có trong tab Driver — chọn từ danh sách` };
    if (hits.length > 1) return { error: `"${part}" khớp ${hits.length} tài xế — gõ rõ hơn` };
    if (names.includes(hits[0].name)) return { error: `"${hits[0].name}" bị lặp lại trong cùng một dòng` };
    names.push(hits[0].name);
  }
  return { name: names.join(DRIVER_SEP) };
}
