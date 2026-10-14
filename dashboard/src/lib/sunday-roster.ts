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
/** Why a rostered driver will not drive that Sunday. */
export type RosterLeave = { kind: "leave" | "resigned"; label: string };
export type RosterWeek = {
  date: string;
  /** Nothing saved for this Sunday yet: `lines` are copied, unsaved, from this
   *  earlier Sunday (the most recent one with a roster). */
  copiedFrom?: string;
  /** Leave filed for that Sunday, by driver id. */
  leave: Record<string, RosterLeave>;
  /** The version check a save sends back: every save mints new ids. */
  ids: number[];
  lines: RosterLine[];
  areas: RosterArea[];
  /** Driver labels for the lines, including accounts no longer active. */
  names: Record<string, string>;
  /** Every Sunday that HAS a roster, newest first — the only weeks worth offering to copy. */
  weeks: string[];
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
 * Who drives a Sunday rule: everyone rostered that day on one of the rule's
 * areas, in roster order, each once — the old sheet's Driver formula, which
 * matched a roster line only when its area equalled one of the rule's areas
 * (case and spacing aside). One driver is a fixed rule, several a smart one.
 */
export function sundayDrivers(areas: readonly string[], lines: readonly { area: string; driver_id: string | null }[]): string[] {
  const keys = new Set(areas.map(areaKey));
  return [...new Set(lines.filter((l) => l.driver_id && keys.has(areaKey(l.area))).map((l) => l.driver_id!))];
}

/**
 * What a supervisor needs to see before saving: areas Sunday rules depend on
 * that nobody covers (those jobs get no driver), and lines on an area no rule
 * points at (the person gets no config jobs that day — often fine, e.g. a BO
 * Runner, but worth seeing).
 */
export function rosterGaps(lines: readonly RosterLine[], areas: readonly RosterArea[]) {
  // A rule's area is found INSIDE a line's area, as the sheet's SEARCH found it:
  // rule "D004" is covered by "D004 ca 1", rule "D029" by "D029 + D046".
  const covered = lines.filter((l) => l.driver_id).map((l) => areaKey(l.area));
  const ruled = areas.filter((a) => a.rules > 0).map((a) => areaKey(a.area));
  return {
    uncovered: areas.filter((a) => a.rules > 0 && !covered.some((k) => k.includes(areaKey(a.area)))),
    unused: new Set(lines.map((l) => areaKey(l.area)).filter((k) => !ruled.some((r) => k.includes(r)))),
  };
}

/** A Sunday rule as the Config tab holds it. */
export type SundayRuleView = { customer_id: string; pickup: string; start: string; end: string; areas?: string[]; alt_drop_off_id?: string; unmapped?: boolean };
export type SundayLine = { start: string; end: string; areas: string[]; alt_drop_off_id: string };

/** The district segment of a Cartrack clinic name: "20198 - TBinh - PVHai - …" → "tbinh". */
export const districtOf = (name: string) => (name.split(" - ")[1] ?? "").trim().toLowerCase();

function mostCommon<T>(items: readonly T[], key: (t: T) => string): T | undefined {
  const counts = new Map<string, { item: T; n: number }>();
  for (const it of items) {
    const k = key(it);
    const hit = counts.get(k);
    if (hit) hit.n++; else counts.set(k, { item: it, n: 1 });
  }
  let best: { item: T; n: number } | undefined;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best?.item;
}

/** Sunday rules of OTHER clinics in the same district, every one with an area. */
function neighbours(pickup: string, customerId: string, rows: readonly SundayRuleView[]) {
  const district = districtOf(pickup);
  return district ? rows.filter((r) => !r.unmapped && r.customer_id !== customerId && r.areas?.length && districtOf(r.pickup) === district) : [];
}

/**
 * The area a clinic's Sunday rule most likely needs: what same-district clinics
 * use for these exact hours (district + hours named the right area for 1,220 of
 * 1,268 rules on 14/10). Null when no neighbour works those hours.
 */
export function suggestSundayArea(pickup: string, customerId: string, start: string, end: string, rows: readonly SundayRuleView[]): string[] | null {
  const same = neighbours(pickup, customerId, rows).filter((r) => r.start === start && r.end === end);
  return mostCommon(same, (r) => r.areas!.join("\n"))?.areas ?? null;
}

/**
 * A whole Sunday for a clinic that has none: the most common day among
 * same-district clinics (hours, areas and alternate drop-off together), with
 * one clinic that has it, so the editor can say where it came from.
 */
export function suggestSundayDay(pickup: string, customerId: string, rows: readonly SundayRuleView[]): { from: string; lines: SundayLine[] } | null {
  const byClinic = new Map<string, SundayRuleView[]>();
  for (const r of neighbours(pickup, customerId, rows)) byClinic.set(r.customer_id, [...(byClinic.get(r.customer_id) ?? []), r]);
  const days = [...byClinic.values()].map((rs) => ({
    from: rs[0].pickup,
    lines: rs.map((r) => ({ start: r.start, end: r.end, areas: r.areas!, alt_drop_off_id: r.alt_drop_off_id ?? "" }))
      .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end)),
  }));
  return mostCommon(days, (d) => JSON.stringify(d.lines)) ?? null;
}
