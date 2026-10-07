/** Date-specific duty windows from Supabase; unknown is never treated as off. */
import { sbSelectAll } from "./supabase-rest";
import { cartrackHistoryCutoff } from "./time";
import { readConfigGen } from "./config-gen";
import { Redis } from "@upstash/redis";
import { masterDrivers, masterEnabled } from "./master-store";
import {
  SHEET_GID,
  SHEET_CONTRACT,
  fetchSheetRows,
  isSheetShapeError,
  noteSheetLoad,
} from "./sheets";

/** One scheduled day, exactly as the flat tab records it. Times are VN-local
 *  `HH:MM`; a blank pair means the day carries no shift. */
export interface ShiftRow {
  employee_code: string;
  full_name: string;
  date: string;
  start: string | null;
  end: string | null;
  leave_start: string | null;
  leave_end: string | null;
  /** The fetcher's flag for "on approved leave but still rostered" — MISA charged
   *  nothing and attached no window, so the person reads as available when they
   *  are not. Carried through rather than resolved here; it is a thing to show a
   *  supervisor, not a thing to silently subtract. */
  leave_gap: boolean;
  driver_id?: string;
}

export type ShiftDay =
  /** A window was rostered for this driver on this day. */
  | { kind: "scheduled"; start: string; end: string; leave_start: string | null; leave_end: string | null; leave_gap: boolean }
  /** A row exists and carries no window: a day off, a public holiday, or a full
   *  day of leave. The schedule positively says "not working". */
  | { kind: "off"; leave_start: string | null; leave_end: string | null; leave_gap: boolean }
  /** No row at all — the date is outside the sheet's rolling window, or this
   *  driver has no pattern, or the tab could not be read. NOT "off". */
  | { kind: "unknown"; reason: "no-row" | "no-employee-code" | "unavailable" };

const UNKNOWN = (reason: "no-row" | "no-employee-code" | "unavailable"): ShiftDay =>
  ({ kind: "unknown", reason });

/** `HH:MM`, and nothing else. The fetcher writes zero-padded times; anything that
 *  does not match is treated as absent rather than half-parsed, because a
 *  mis-read hour is a mis-paid shift. */
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const time = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return TIME_RE.test(t) ? (t.length === 4 ? `0${t}` : t) : null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ShiftIndex {
  /** `employee_code|date` → the day. */
  byCodeDate: Map<string, ShiftRow>;
  /** Cartrack driver uuid → employee code, from the Driver roster tab. */
  codeByDriverId: Map<string, string>;
  /** The dates the schedule actually spans, so a caller can tell "not scheduled"
   *  from "we have no data for that month at all". */
  from: string | null;
  to: string | null;
  /** True when either tab failed to load and this index is empty or partial. */
  degraded: boolean;
}

const EMPTY: ShiftIndex = {
  byCodeDate: new Map(),
  codeByDriverId: new Map(),
  from: null,
  to: null,
  degraded: true,
};

// ── Caching ─────────────────────────────────────────────────────────────────
//
// Two tiers, the same shape `leave-config.ts` uses and for the same reasons: a
// short in-process cache so one request does not re-fetch, and Redis so a cold
// instance does not either (cold starts are what make an in-memory-only cache a
// no-op — see the shared-cache note in the deploy memory).
//
// Writes and Tải lại invalidate the shared generation. TTL is a backstop for
// external database edits when nobody has requested refresh.

const MEM_TTL_MS = 10 * 60 * 1000;
const REDIS_TTL_S = 60 * 60;
const REDIS_KEY = masterEnabled() ? "shifts:v3" : "shifts:v1";

let mem: { at: number; index: ShiftIndex; gen: string | null } | null = null;

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/** Wire form: tuples, not objects. ~6,600 rows a day go through this key and the
 *  key-value plan is billed on bandwidth as well as commands, so the field names
 *  are not worth repeating 6,600 times. */
type WireRow = [string, string, string, string | null, string | null, string | null, string | null, 0 | 1];
interface Wire {
  gen?: string | null;
  rows: WireRow[];
  roster: [string, string][];
  from: string | null;
  to: string | null;
}

const toWire = (i: ShiftIndex): Wire => ({
  rows: [...i.byCodeDate.values()].map((r) => [
    r.employee_code, r.full_name, r.date, r.start, r.end, r.leave_start, r.leave_end, r.leave_gap ? 1 : 0,
  ]),
  roster: [...i.codeByDriverId.entries()],
  from: i.from,
  to: i.to,
});

function fromWire(w: Wire): ShiftIndex {
  const byCodeDate = new Map<string, ShiftRow>();
  for (const [employee_code, full_name, date, start, end, leave_start, leave_end, gap] of w.rows) {
    byCodeDate.set(`${employee_code}|${date}`, {
      employee_code, full_name, date, start, end, leave_start, leave_end, leave_gap: gap === 1,
    });
  }
  return {
    byCodeDate,
    codeByDriverId: new Map(w.roster),
    from: w.from,
    to: w.to,
    degraded: false,
  };
}

// ── Loading ─────────────────────────────────────────────────────────────────

/**
 * The Cartrack uuid → staff code join, read from the Driver roster tab.
 *
 * DEACTIVATED ROWS ARE KEPT, which is why this does not reuse
 * `loadDriversFromSheet()`. That loader drops them on purpose — a deactivated
 * account cannot take a job, so it has no business in a picker. But payroll runs
 * on the 25th for the month just ended, and somebody who left in that month must
 * still resolve to their schedule. Dropping them here would not fail loudly; it
 * would quietly answer `unknown` for exactly the people whose final payslip is
 * being worked out.
 */
async function loadRosterCodes(): Promise<Map<string, string>> {
  if (masterEnabled()) {
    const drivers = await masterDrivers();
    const out = new Map<string, string>();
    for (const driver of drivers) {
      const code = driver.roster?.employee_code?.trim();
      if (code) out.set(driver.driver_id, code);
    }
    if (out.size < 100) throw new Error("Master driver employee-code roster is suspiciously short");
    return out;
  }
  const rows = await fetchSheetRows(SHEET_GID.drivers, {
    label: SHEET_CONTRACT.drivers.label,
    require: SHEET_CONTRACT.drivers.require,
    expect: ["employee_code"],
  });
  const out = new Map<string, string>();
  for (const row of rows) {
    const id = (row["delivery_driver_id"] ?? "").trim();
    const code = (row["employee_code"] ?? "").trim();
    if (id && code) out.set(id, code);
  }
  return out;
}

async function loadShiftRows(): Promise<{ rows: ShiftRow[]; from: string | null; to: string | null }> {
  const raw = masterEnabled()
    ? (await sbSelectAll<{employee_code:string;full_name:string;shift_date:string;start_time:string|null;end_time:string|null;leave_start:string|null;leave_end:string|null;leave_gap:boolean;driver_id:string|null}>(
        "driver_shifts", `select=employee_code,full_name,shift_date,start_time,end_time,leave_start,leave_end,leave_gap,driver_id&shift_date=gte.${cartrackHistoryCutoff()}`, "employee_code.asc,shift_date.asc,slot.asc"))
      .map(r => ({employee_code:r.employee_code,full_name:r.full_name,date:r.shift_date,start_time:r.start_time??"",end_time:r.end_time??"",leave_start_time:r.leave_start??"",leave_end_time:r.leave_end??"",leave_gap:r.leave_gap?"1":"",driver_id:r.driver_id??""}))
    : await fetchSheetRows(SHEET_GID.driver_shift, SHEET_CONTRACT.driver_shift);
  const rows: ShiftRow[] = [];
  let from: string | null = null;
  let to: string | null = null;

  for (const r of raw) {
    const employee_code = (r["employee_code"] ?? "").trim();
    const date = (r["date"] ?? "").trim();
    if (!employee_code || !DATE_RE.test(date)) continue;

    rows.push({
      employee_code,
      driver_id: r["driver_id"] || undefined,
      full_name: (r["full_name"] ?? "").trim(),
      date,
      start: time(r["start_time"]),
      end: time(r["end_time"]),
      leave_start: time(r["leave_start_time"]),
      leave_end: time(r["leave_end_time"]),
      leave_gap: (r["leave_gap"] ?? "").trim() === "1",
    });
    if (!from || date < from) from = date;
    if (!to || date > to) to = date;
  }
  return { rows, from, to };
}

/**
 * The whole schedule, both tabs joined.
 *
 * A failure of either tab returns the LAST GOOD in-process copy if there is one,
 * and a `degraded` empty index otherwise — never a half-built one. Same
 * discipline as the config loaders: an empty schedule is never real (there are
 * always thousands of rows), so it is not cached and not allowed to look
 * authoritative.
 */
export async function loadShiftIndex(fresh = false): Promise<ShiftIndex> {
  const gen = masterEnabled() ? await readConfigGen() : null;
  if (!fresh && mem && mem.gen === gen && Date.now() - mem.at < MEM_TTL_MS) return mem.index;

  const redis = getRedis();
  if (!fresh && redis) {
    try {
      const hit = await redis.get<Wire>(REDIS_KEY);
      if (hit?.rows?.length && (!masterEnabled() || hit.gen === gen)) {
        const index = fromWire(hit);
        mem = { at: Date.now(), index, gen };
        return index;
      }
    } catch {
      /* cache read is best-effort — fall through to the sheet */
    }
  }

  try {
    const [{ rows, from, to }, codeByDriverId] = await Promise.all([
      loadShiftRows(),
      loadRosterCodes(),
    ]);

    // Never cache an empty schedule. A network hiccup that returns a header-only
    // CSV would otherwise be cached for the hour and answer `unknown` for the
    // whole fleet — the exact failure footgun 3 documents for the mapping tab.
    if (rows.length === 0) {
      console.error("Driver Shift load returned 0 rows — not caching");
      return mem?.index ?? EMPTY;
    }

    const byCodeDate = new Map<string, ShiftRow>();
    for (const r of rows) {
      byCodeDate.set(`${r.employee_code}|${r.date}`, r);
      if (r.driver_id) codeByDriverId.set(r.driver_id, r.employee_code);
    }

    const index: ShiftIndex = { byCodeDate, codeByDriverId, from, to, degraded: false };
    noteSheetLoad(SHEET_CONTRACT.driver_shift.label, null);
    mem = { at: Date.now(), index, gen };
    if (redis) {
      try {
        await redis.set(REDIS_KEY, {...toWire(index), gen}, { ex: REDIS_TTL_S });
      } catch {
        /* cache write is best-effort */
      }
    }
    return index;
  } catch (e) {
    if (isSheetShapeError(e)) noteSheetLoad(e.sheetLabel, e);
    console.error("Error loading driver shifts:", e);
    return mem?.index ?? EMPTY;
  }
}

/** Drop both cache tiers. For the dashboard Refresh path, alongside the other
 *  config invalidations. Awaited for the reason `invalidateLeaveCache` is: a
 *  serverless instance can be torn down the instant it responds, so a
 *  fire-and-forget DELETE may never land. */
export async function invalidateShiftCache(): Promise<void> {
  mem = null;
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(REDIS_KEY);
  } catch {
    /* best-effort; the TTL is the backstop */
  }
}

// ── Lookup ──────────────────────────────────────────────────────────────────

/** The scheduled day for a staff code. */
export function shiftDayForCode(index: ShiftIndex, code: string, date: string): ShiftDay {
  const row = index.byCodeDate.get(`${code}|${date}`);
  if (!row) return UNKNOWN(index.degraded ? "unavailable" : "no-row");
  if (row.start && row.end) {
    return {
      kind: "scheduled",
      start: row.start,
      end: row.end,
      leave_start: row.leave_start,
      leave_end: row.leave_end,
      leave_gap: row.leave_gap,
    };
  }
  return {
    kind: "off",
    leave_start: row.leave_start,
    leave_end: row.leave_end,
    leave_gap: row.leave_gap,
  };
}

/** The scheduled day for a Cartrack driver uuid — the id every pay row carries.
 *
 *  A driver the roster has no `employee_code` for answers `no-employee-code`
 *  rather than `no-row`, because the two are fixed in different places: one is a
 *  missing cell on the Driver tab, the other a missing row on the pattern tab. */
export function shiftDayForDriver(index: ShiftIndex, driverId: string, date: string): ShiftDay {
  const code = index.codeByDriverId.get(driverId);
  if (!code) return UNKNOWN(index.degraded ? "unavailable" : "no-employee-code");
  return shiftDayForCode(index, code, date);
}

/** Whether the schedule covers a date at all. `false` means every lookup for
 *  that date will answer `unknown` for everyone — worth saying once on a screen
 *  rather than 45 times. */
export const coversDate = (index: ShiftIndex, date: string): boolean =>
  !!index.from && !!index.to && date >= index.from && date <= index.to;

/** Minutes between two `HH:MM` on the same day. Null when either is unparseable
 *  or the window runs backwards — an overnight window is not something this
 *  schedule expresses, so a negative span is bad data, not a night shift. */
export function windowMinutes(start: string, end: string): number | null {
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) return null;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const mins = eh * 60 + em - (sh * 60 + sm);
  return mins > 0 ? mins : null;
}
