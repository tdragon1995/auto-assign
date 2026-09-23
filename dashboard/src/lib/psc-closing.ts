/**
 * PSC closing hours: send a job somewhere open, and send it home again once it can go.
 *
 * WHEN. Only from 19:00, Monday to Saturday (`isClosingWindow`). Before that, and all
 * day Sunday, every PSC counts as open: the sheet is not even read, and nothing is
 * moved. The one thing that still happens outside the window is the way BACK (below),
 * because the job carried over from last night comes up in the morning.
 *
 * THE RULE. When a job is about to be assigned and its drop-off PSC has passed its
 * `closing_time`, the drop-off moves to that PSC's `next_best_psc`. Both columns are
 * on the PSC mapping tab (SHEET_GID.psc), one row per PSC, typed by a person. If the
 * next best has closed too, ITS next best is tried, and so on. Nothing open → the job
 * is left alone.
 *
 * THE WAY BACK. A job moved because its PSC had closed is carrying a destination it
 * was never booked for. If it does not finish that evening — the morning rollover
 * carries it over, "Hẹn giờ" moves it to tomorrow, someone re-dates it in Cartrack —
 * it would otherwise travel to the fallback forever. So every swap leaves a record
 * of the ORIGINAL drop-off (`dropoff_swap:<env>:<jobId>`, smart-log-kv.ts), and when
 * the job comes up for assignment again the original is tried FIRST. Open again →
 * the job goes back to it and the record is dropped. Still closed (re-dated to a
 * time after closing) → the same rule simply applies again.
 *
 * The record is only READ for jobs created before today: a same-day job cannot have
 * been re-dated to a later day, and reading it for every job every cycle would put a
 * command on the per-cycle path (see the COMMAND BUDGET header in smart-log-kv.ts).
 *
 * alt_drop_off_id needs no record. That column REWRITES the destination on every
 * assign, so a job whose alt target had closed is put back by the next assign on its
 * own — the configured destination is re-derived, not remembered.
 *
 * Everything but `loadPscTable` is pure, so the decision can be pinned offline
 * (scripts/psc-closing.test.mts).
 */

import { SHEET_CONTRACT, SHEET_GID, fetchSheetRows, isSheetShapeError, noteSheetLoad, noteSheetWarning } from "./sheets";
import { vnIsSunday, vnMinutesSinceMidnight } from "./time";

export interface PscInfo {
  customer_id: string;
  name: string;
  /** Minutes since VN midnight the PSC stops receiving, or null = never closes. */
  closeMin: number | null;
  /** The PSC's `next_best_psc`, resolved to a customer id. "" = none. */
  hubId: string;
}

export type PscTable = ReadonlyMap<string, PscInfo>;

/** A remembered swap: the job was booked to `from`, the engine moved it to `to`. */
export interface DropoffSwapRecord {
  from: string;
  to: string;
  /** VN date of the swap — for the log, and for a person reading the key. */
  on: string;
}

/**
 * "20:00", "20:00:00", "20h", "20h30", "8:30" → minutes since midnight.
 *
 * Blank, "00:00" and "24:00" all mean NEVER closes, not "closed from midnight": a
 * PSC typed as closing at midnight is open for the whole working day, and reading
 * 00:00 literally would divert every job it receives. Anything unreadable is also
 * null, so a typo fails OPEN — the job goes where it was booked, which is exactly
 * what happened before this feature existed.
 */
export function parseClosingTime(raw: string | undefined | null): number | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\s*(?::|h)\s*(\d{2})?(?::\d{2})?$/) ?? s.match(/^(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h === 24 && min === 0) return null;
  if (h > 23 || min > 59) return null;
  const total = h * 60 + min;
  return total === 0 ? null : total;
}

/** The check runs from 19:00, Monday to Saturday. */
export const CLOSING_CHECK_FROM_MIN = 19 * 60;

export function isClosingWindow(now: Date = new Date()): boolean {
  return !vnIsSunday(now) && vnMinutesSinceMidnight(now) >= CLOSING_CHECK_FROM_MIN;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The PSC mapping tab, keyed by the PSC's Cartrack customer id (`pickup`).
 *
 * `next_best_psc` is typed as a person would say it — "D001", "BRA - D001" — or as a
 * customer id, and resolved against the tab's own PSCs. One that names no PSC on the
 * tab is listed in `unresolved` so it can be reported, and counts as "none".
 *
 * A PSC on two rows (D036 has two routes) is merged: the first filled value of each
 * column wins, so the hours only have to be typed once.
 */
export function buildPscTable(rows: Record<string, string>[]): { table: Map<string, PscInfo>; unresolved: string[] } {
  const byCode = new Map<string, string>();
  const raw = new Map<string, { name: string; close: string; next: string }>();
  for (const r of rows) {
    const name = (r["psc_pickup"] ?? "").trim();
    const id = (r["pickup"] ?? "").trim();
    if (!name || !UUID_RE.test(id)) continue;
    if (!byCode.has(pscCode(name).toUpperCase())) byCode.set(pscCode(name).toUpperCase(), id);
    const prev = raw.get(id);
    const close = (r["closing_time"] ?? "").trim();
    const next = (r["next_best_psc"] ?? "").trim();
    raw.set(id, { name: prev?.name || name, close: prev?.close || close, next: prev?.next || next });
  }
  const table = new Map<string, PscInfo>();
  const unresolved: string[] = [];
  for (const [id, r] of raw) {
    let hub = "";
    if (r.next) {
      hub = UUID_RE.test(r.next) ? r.next : byCode.get(pscCode(r.next).toUpperCase()) ?? "";
      if (!hub) unresolved.push(`${pscCode(r.name)} → "${r.next}"`);
    }
    table.set(id, { customer_id: id, name: r.name, closeMin: parseClosingTime(r.close), hubId: hub === id ? "" : hub });
  }
  return { table, unresolved };
}

export function isClosed(psc: PscInfo | undefined, nowMin: number): boolean {
  return !!psc && psc.closeMin != null && nowMin >= psc.closeMin;
}

/**
 * The first OPEN drop-off on `targetId`'s chain, or null when every link has closed
 * (or the chain loops, or runs into the job's own pickup — a job cannot be sent to
 * the place it is collected from). `closed` lists the PSCs skipped, in order, for
 * the log line. A target that is not a PSC, or has no closing time, is its own answer.
 */
export function resolveOpenDropoff(
  table: PscTable,
  targetId: string,
  nowMin: number,
  pickupId: string | null,
): { id: string | null; closed: PscInfo[] } {
  const closed: PscInfo[] = [];
  const seen = new Set<string>();
  let cur = targetId;
  for (;;) {
    const psc = table.get(cur);
    if (!isClosed(psc, nowMin)) return { id: cur, closed };
    closed.push(psc!);
    seen.add(cur);
    const next = psc!.hubId;
    if (!next || seen.has(next) || next === pickupId) return { id: null, closed };
    cur = next;
  }
}

export type DropoffReason =
  | "keep"        // nothing to do
  | "alt"         // alt_drop_off_id rewrites the destination (pre-existing behaviour)
  | "closed"      // the configured destination has closed → moved down its chain
  | "revert"      // a job moved on an earlier day goes back to where it was booked
  | "all_closed"; // configured destination closed and nothing open behind it

export interface DropoffPlan {
  /** Where the job should go. Equal to the current drop-off when nothing changes. */
  targetId: string;
  /** Where it would go if every PSC were open. */
  configuredId: string;
  reason: DropoffReason;
  closed: PscInfo[];
  /** What to do with the swap record. */
  record: { set: DropoffSwapRecord } | "delete" | null;
}

/**
 * Decide a job's drop-off. Pure.
 *
 * `record` is honoured only while the job still points where the engine left it
 * (`record.to === currentId`). If a person has since changed the drop-off by hand,
 * that choice wins and the record is dropped — the engine never undoes a human.
 */
export function planDropoff(args: {
  table: PscTable;
  currentId: string;
  altId: string;
  record: DropoffSwapRecord | null;
  pickupId: string | null;
  nowMin: number;
  today: string;
  exempt: boolean;
}): DropoffPlan {
  const { table, currentId, altId, record, pickupId, nowMin, today, exempt } = args;
  const liveRecord = record && record.to === currentId ? record : null;
  const configuredId = altId || liveRecord?.from || currentId;

  // PSC tỉnh and the engine's own legs are routes someone designed end to end; the
  // return-trip and via logic key on their exact pickup→dropoff pair. Alt only,
  // exactly as before.
  if (exempt) {
    return {
      targetId: altId || currentId,
      configuredId: altId || currentId,
      reason: altId && altId !== currentId ? "alt" : "keep",
      closed: [],
      record: null,
    };
  }

  const res = resolveOpenDropoff(table, configuredId, nowMin, pickupId);
  // Nothing open anywhere: leave the job exactly where it is. An alt row still
  // rewrites as it always has; a job moved earlier is NOT sent back to a PSC that
  // is itself closed.
  const targetId = res.id ?? (altId ? configuredId : currentId);
  let reason: DropoffReason;
  if (res.id == null) reason = "all_closed";
  else if (targetId !== configuredId) reason = "closed";
  else if (targetId !== currentId) reason = altId ? "alt" : "revert";
  else reason = "keep";

  // Remember the ORIGINAL only where nothing else will: alt re-derives itself, and
  // a record that already says exactly this is not written again every cycle.
  let rec: DropoffPlan["record"] = null;
  if (!altId && targetId !== configuredId) {
    if (!(liveRecord && liveRecord.from === configuredId && liveRecord.to === targetId)) {
      rec = { set: { from: configuredId, to: targetId, on: today } };
    }
  } else if (record && targetId === configuredId) {
    rec = "delete";
  }

  return { targetId, configuredId, reason, closed: res.closed, record: rec };
}

/** "20:00" for the log line. */
export function fmtMin(min: number | null): string {
  if (min == null) return "—";
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** "D014" out of "BRA - D014" — the code people actually say. */
export function pscCode(name: string): string {
  return name.match(/D\d+/i)?.[0] ?? name;
}

// ── The sheet read ────────────────────────────────────────────────────────────
//
// Only ever called inside the closing window, so the tab is read in the evening and
// never during the day. Cached ten minutes per instance: it is ~50 rows, and an edit
// to tonight's hours should land within one or two cycles.
//
// FAILS OPEN. An unreadable tab returns the last good copy, or null when there has
// never been one — and null means "check nothing", which is the behaviour before
// this feature. A job is never diverted on a guess.

const TABLE_TTL_MS = 10 * 60 * 1000;
const A_NEXT_BEST = "PSC mapping — next_best_psc không ra PSC";
let cachedTable: Map<string, PscInfo> | null = null;
let cachedAt = 0;
let inflight: Promise<Map<string, PscInfo> | null> | null = null;

export async function loadPscTable(): Promise<PscTable | null> {
  if (cachedTable && Date.now() - cachedAt < TABLE_TTL_MS) return cachedTable;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const rows = await fetchSheetRows(SHEET_GID.psc, SHEET_CONTRACT.psc);
      noteSheetLoad(SHEET_CONTRACT.psc.label, null);
      const { table, unresolved } = buildPscTable(rows);
      noteSheetWarning(A_NEXT_BEST, unresolved.length ? unresolved.join(", ") : null);
      // A PSC-less parse is a wrong read, not a network with no PSCs in it.
      if (table.size === 0) return cachedTable;
      cachedTable = table;
      cachedAt = Date.now();
      return table;
    } catch (e) {
      if (isSheetShapeError(e)) noteSheetLoad(e.sheetLabel, e);
      console.error("PSC closing hours: PSC mapping tab unreadable —", e);
      return cachedTable;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Dashboard Refresh: the next assign re-reads the tab. */
export function invalidatePscTable(): void {
  cachedTable = null;
  cachedAt = 0;
}
