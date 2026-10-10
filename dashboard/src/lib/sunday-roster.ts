/**
 * The weekly Sunday roster: who covers which AREA on a given Sunday.
 *
 * A Sunday config rule names an area, never a driver (the sheet's Driver column
 * was a lookup into the public roster by area), so this table is what decides
 * who drives a Sunday rule. Pure helpers only — shared by the roster page and
 * its API route, so nothing here may import server code.
 */
import { addDays } from "./time";

export type RosterLine = { area: string; driver_id: string | null; raw_name: string | null; shift: string; note: string };
/** An area someone can be rostered on, and how many Sunday rules point at it. */
export type RosterArea = { area: string; rules: number };
export type RosterWeek = {
  date: string;
  /** The version check a save sends back: every save mints new ids. */
  ids: number[];
  lines: RosterLine[];
  areas: RosterArea[];
  /** Driver labels for the lines, including accounts no longer active. */
  names: Record<string, string>;
};

/** How an area is matched to a rule: case and spacing never count, exactly as
 *  the sheet's case-insensitive SEARCH treated "Bình chánh" and "Bình Chánh". */
export const areaKey = (area: string) => area.trim().replace(/\s+/g, " ").toLowerCase();

export function isSunday(date: unknown): date is string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date && d.getUTCDay() === 0;
}

/** The Sunday an edit made on `date` is for: that day itself on a Sunday,
 *  otherwise the coming one — the same week the sheet's date formula showed. */
export function rosterSunday(date: string): string {
  return addDays(date, (7 - new Date(`${date}T00:00:00Z`).getUTCDay()) % 7);
}

const SHIFT = /^([01]?\d|2[0-3]):[0-5]\d - ([01]?\d|2[0-3]):[0-5]\d$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validShift = (shift: string) => !shift.trim() || SHIFT.test(shift.trim());

/** Validate a week as the page sends it. Throws the sentence to show. */
export function parseRosterLines(input: unknown): RosterLine[] {
  if (!Array.isArray(input) || input.length > 200) throw new Error("Danh sách lịch không hợp lệ");
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const l = (raw ?? {}) as Record<string, unknown>;
    const n = i + 1;
    const area = typeof l.area === "string" ? l.area.trim().replace(/\s+/g, " ") : "";
    if (!area || area.length > 200) throw new Error(`Dòng ${n}: chọn khu vực`);
    const driver_id = l.driver_id === null || l.driver_id === "" || l.driver_id === undefined ? null : l.driver_id;
    if (driver_id !== null && (typeof driver_id !== "string" || !UUID.test(driver_id))) throw new Error(`Dòng ${n}: tài xế không hợp lệ`);
    const text = (v: unknown, max: number) => {
      if (v !== null && v !== undefined && typeof v !== "string") throw new Error(`Dòng ${n}: dữ liệu không hợp lệ`);
      const s = (v ?? "").trim();
      if (s.length > max) throw new Error(`Dòng ${n}: nội dung quá dài`);
      return s;
    };
    const shift = text(l.shift, 20), note = text(l.note, 500), raw_name = text(l.raw_name, 200);
    if (!validShift(shift)) throw new Error(`Dòng ${n}: ca phải có dạng 06:00 - 15:00`);
    // The database refuses this too, but by then the message names no line.
    if (driver_id) {
      const key = `${areaKey(area)}|${driver_id}`;
      if (seen.has(key)) throw new Error(`Dòng ${n}: tài xế đã có trong khu vực này`);
      seen.add(key);
    }
    return { area, driver_id, raw_name: driver_id ? null : raw_name || null, shift, note };
  });
}

/**
 * What a supervisor needs to see before saving: areas Sunday rules depend on
 * that nobody covers (those jobs get no driver), and lines on an area no rule
 * points at (the person gets no config jobs that day — often fine, e.g. a BO
 * Runner, but worth seeing).
 */
export function rosterGaps(lines: readonly RosterLine[], areas: readonly RosterArea[]) {
  const covered = new Set(lines.filter((l) => l.driver_id).map((l) => areaKey(l.area)));
  const ruled = new Set(areas.filter((a) => a.rules > 0).map((a) => areaKey(a.area)));
  return {
    uncovered: areas.filter((a) => a.rules > 0 && !covered.has(areaKey(a.area))),
    unused: new Set(lines.map((l) => areaKey(l.area)).filter((k) => !ruled.has(k))),
  };
}
