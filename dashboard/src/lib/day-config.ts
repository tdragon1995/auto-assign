/**
 * Which config rules govern a GIVEN DATE — not today.
 *
 * The workbook holds two complete config tabs: the weekday mapping table and a
 * separate "CONFIG SUNDAY". `loadConfigFromSheets` returns whichever one
 * governs RIGHT NOW, which is exactly right for the assign cycle — it only ever
 * dispatches today's jobs — and exactly wrong for anything that reasons about a
 * leave row, because a leave row carries its own date.
 *
 * WHAT THAT COST. Nguyễn Hoàng Nhân drives on Sundays only: sixty rows on the
 * Sunday tab, none on the weekday one. A leave row filed for a MONDAY was
 * judged against whichever tab happened to be loaded, so a reconcile running on
 * a Sunday saw him on duty 06:00–08:00 and generated a "Thay ca" for a day he
 * does not work. The same fault runs the other way and is quieter: on a weekday,
 * a Sunday leave is judged against weekday rules, so a real Sunday conflict —
 * and the part-time companion that should follow it — is never noticed at all.
 *
 * So the rule is: pick the tab from the DATE BEING JUDGED. A date that happens
 * to be today costs nothing extra, because that tab is already loaded and
 * cached; the other one is fetched here.
 *
 * THE READ HERE IS DELIBERATELY NARROW. `loadConfigFromSheets` parses far more
 * than duty hours — branch names, coverage gaps, overlaps, the unfinished-row
 * to-do list — and all of it exists to be shown on the dashboard for TODAY.
 * Nothing that asks this module a question wants any of that; they want to know
 * who is on duty and when. So this reads the five fields that answer it and
 * drops the row on the same condition the full parse drops it on (a row with no
 * branch, or with neither a fixed driver nor a smart pool, is not a duty).
 * Anything beyond those fields belongs in the full parse, not here.
 */
import type { Mapping } from "./types";
import { isValidDriverId, parseTime } from "./config";
import { SHEET_CONTRACT, SHEET_GID, fetchSheetRows } from "./sheets";
import { vnDate } from "./time";

export type ConfigTab = "mapping" | "sunday";

/** Which tab governs `date` ("YYYY-MM-DD"). Read as UTC so the answer does not
 *  depend on where the server is; a date string carries no zone of its own, and
 *  these are already Saigon dates. An unparseable date falls back to the weekday
 *  table, which is what all but one day in seven is. */
export function configTabForDate(date: string): ConfigTab {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t)) return "mapping";
  return new Date(t).getUTCDay() === 0 ? "sunday" : "mapping";
}

/** The duty fields, and only those — see the header. */
function dutyRows(rows: readonly Record<string, string>[]): Mapping[] {
  const out: Mapping[] = [];
  for (const row of rows) {
    const customer_id = row["customer_id"] ?? "";
    const driver_id = (row["driver_id"] ?? "").trim();
    const smart_driver_id = (row["smart_driver_id"] ?? "")
      .split(",").map((s) => s.trim()).filter(isValidDriverId);
    // The full parse's own drop test. A row with no branch, or with nobody on
    // it, is not duty — and reporting WHY it was dropped is that parse's job,
    // not this one's.
    if (!customer_id || (!driver_id && smart_driver_id.length === 0)) continue;
    out.push({
      customer_id, driver_id, smart_driver_id,
      shift_start: parseTime(row["shift_start"]),
      shift_end: parseTime(row["shift_end"]),
      // Not read by any duty question, and not invented either: these carry the
      // empty value the type calls for so nothing downstream reads a stale one.
      dropoff_id: (row["dropoff_id"] ?? "").trim(),
      first_name_last_name: (row["Driver"] ?? "").trim(),
      bot_token: "", chat_id: "", alt_drop_off_id: "",
    });
  }
  return out;
}

// A day's copy of each tab, in-process only: these are asked on a leave write
// and by the Thay ca reconcile, not on the assign cycle, so a cold instance
// paying one CSV fetch is cheaper than a Redis key every instance would then
// have to keep honest.
//
// BOTH tabs are read here, including the one that happens to be today's, rather
// than borrowing today's from `loadConfigFromSheets`. Borrowing it would mean
// deciding separately which tab that is, and the config loader carries a note
// about exactly that: reading the clock twice let a fetch crossing midnight
// cache Saturday's tab under Sunday's date. Here the same slip would hand back
// the SUNDAY table as the weekday rules — the very fault this module exists to
// remove — for the requests inside that sliver. One extra fetch a day, on a
// path taken a handful of times, buys the question being unaskable.
const tabs: Partial<Record<ConfigTab, { day: string; mappings: Mapping[] }>> = {};

async function loadTab(tab: ConfigTab): Promise<Mapping[] | null> {
  const today = vnDate();
  const hit = tabs[tab];
  if (hit && hit.day === today) return hit.mappings;
  try {
    const mappings = dutyRows(await fetchSheetRows(SHEET_GID[tab], SHEET_CONTRACT[tab]));
    // The same zero-length suspicion the config loader has: a tab that parses to
    // nothing is a bad read, not an empty roster, and adopting it would answer
    // "nobody is on duty" to every question for the rest of the day.
    if (mappings.length === 0) return null;
    tabs[tab] = { day: today, mappings };
    return mappings;
  } catch {
    return null;
  }
}

/** Resolves a date to the rules that govern it. Built once, asked many times —
 *  `deriveThayCaRows` walks every day of every leave row. */
export interface DayMappings {
  forDate(date: string): readonly Mapping[];
}

/**
 * Both tabs, ready to answer for any date. Null when either could not be read —
 * a caller that cannot see a whole day's rules must not conclude "nobody is on
 * duty then" and quietly generate or withhold rows on that basis.
 */
export async function loadDayMappings(): Promise<DayMappings | null> {
  const [weekday, sunday] = await Promise.all([loadTab("mapping"), loadTab("sunday")]);
  if (!weekday || !sunday) return null;
  return { forDate: (date) => (configTabForDate(date) === "sunday" ? sunday : weekday) };
}

/** The rules governing one date. Null on an unreadable tab, for the reason
 *  `loadDayMappings` gives. */
export async function mappingsForDate(date: string): Promise<readonly Mapping[] | null> {
  return await loadTab(configTabForDate(date));
}
