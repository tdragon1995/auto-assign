/**
 * PSC closing hours: send a job somewhere open, and send it home again once it can go.
 *
 * WHEN. From 18:50, Monday to Saturday (`isClosingWindow`), and a PSC counts as
 * closed CLOSING_LEAD_MIN (10) minutes before its closing time — a job sent to a
 * 19:00 PSC at 18:55 would arrive after it shut. Before 18:50, and all day Sunday,
 * every PSC counts as open and nothing is moved. The one thing that still happens
 * outside the window is the way BACK (below), because the job carried over from
 * last night comes up in the morning.
 *
 * THE RULE. When a job is about to be assigned — or is already assigned but its
 * sample not yet collected (`pickAssignedSwitches`) — and its drop-off PSC has
 * passed its closing time, the drop-off moves to that PSC's next best. Both are hard-coded in
 * `PSC_CLOSING` (psc-routes-data.ts) beside the PSC routes, which have been the source
 * of truth since the sheet tab was retired — so this reads nothing at runtime. If the
 * next best has closed too, ITS next best is tried, and so on. Nothing open (or no
 * next best given) → the job is left alone.
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
 * All of it is pure, so the decision is pinned offline (scripts/psc-closing.test.mts).
 */

import { PSC_CLOSING, PSC_ROUTES } from "./psc-routes-data";
import { vnIsSunday, vnMinutesSinceMidnight } from "./time";

export interface PscInfo {
  customer_id: string;
  name: string;
  /** Minutes since VN midnight the PSC stops receiving, or null = never closes. */
  closeMin: number | null;
  /** The PSC's next best, resolved to a customer id. "" = none. */
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

/** A PSC counts as closed this many minutes before its closing time: a job moved
 *  at the last minute would still arrive after the door shut. */
export const CLOSING_LEAD_MIN = 10;

/** The check runs from 18:50 (the earliest closing, 19:00, less the lead),
 *  Monday to Saturday. */
export const CLOSING_CHECK_FROM_MIN = 19 * 60 - CLOSING_LEAD_MIN;

export function isClosingWindow(now: Date = new Date()): boolean {
  return !vnIsSunday(now) && vnMinutesSinceMidnight(now) >= CLOSING_CHECK_FROM_MIN;
}

/** The clock closing times are compared against: now plus the lead. Pass this,
 *  never the bare minute, wherever a real job is being judged. */
export function closingClockMin(now: Date = new Date()): number {
  return vnMinutesSinceMidnight(now) + CLOSING_LEAD_MIN;
}

/**
 * Join the hours onto the PSC list, keyed by the PSC's Cartrack customer id.
 *
 * Both sides are keyed by PSC code ("D014"). A code in `closing` that matches no PSC,
 * or a `next` that does, is listed in `unresolved` — the test fails on any, so a typo
 * is caught before deploy rather than quietly never diverting anything.
 */
export function buildPscTable(
  pscs: readonly { psc_pickup: string; pickup: string }[],
  closing: Readonly<Record<string, { close: string; next?: string }>>,
): { table: Map<string, PscInfo>; unresolved: string[] } {
  const idByCode = new Map<string, { id: string; name: string }>();
  for (const p of pscs) {
    const code = pscCode(p.psc_pickup).toUpperCase();
    if (p.pickup && !idByCode.has(code)) idByCode.set(code, { id: p.pickup, name: p.psc_pickup });
  }
  const table = new Map<string, PscInfo>();
  const unresolved: string[] = [];
  for (const [code, h] of Object.entries(closing)) {
    const psc = idByCode.get(code.toUpperCase());
    if (!psc) { unresolved.push(code); continue; }
    let hub = "";
    if (h.next) {
      hub = idByCode.get(h.next.toUpperCase())?.id ?? "";
      if (!hub) unresolved.push(`${code} → ${h.next}`);
    }
    table.set(psc.id, { customer_id: psc.id, name: psc.name, closeMin: parseClosingTime(h.close), hubId: hub === psc.id ? "" : hub });
  }
  return { table, unresolved };
}

/** The live table. Built once at load; nothing to fetch, nothing to go stale. */
export const PSC_TABLE: PscTable = buildPscTable(PSC_ROUTES, PSC_CLOSING).table;

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

// ── Jobs already assigned ─────────────────────────────────────────────────────

/** The fields `pickAssignedSwitches` reads — a Job from the cycle's assigned list. */
export interface AssignedJobLike {
  job_id: number;
  delivery_driver_id?: string | null;
  labels?: string[];
  last_assigned_plan_id?: number | null;
  stops: { stop_type_id?: number; stop_status_id?: number; customer_id?: string }[];
}

/**
 * Assigned jobs whose drop-off PSC has closed and whose SAMPLE IS STILL AT THE
 * CLIENT — pickup waiting, en route or arrived (1–3), drop-off not started (1).
 * Once the sample is collected the job is left alone: the driver is already
 * carrying it, and changing where they are heading mid-ride is a call for a
 * person, not the engine.
 *
 * Also left alone: a job on a proxy driver (parked or being rejected), a Cartrack
 * PLAN job (it regenerates daily on its own route), PSC tỉnh and the engine's own
 * legs (`skip.labels`), and anything collected FROM a Diag location
 * (`skip.pickupIds`) — a branch-to-branch bag run goes where it was sent. A job
 * with more than one drop-off is not guessed at. Unknown stop statuses count as
 * "not safe", never as "not started".
 *
 * Pure: reads the list the cycle already fetched, writes nothing.
 */
export function pickAssignedSwitches<J extends AssignedJobLike>(
  jobs: readonly J[],
  table: PscTable,
  nowMin: number,
  skip: { driverIds: ReadonlySet<string>; pickupIds: ReadonlySet<string>; labels: readonly string[] },
): { job: J; fromId: string; targetId: string; closed: PscInfo[] }[] {
  const out: { job: J; fromId: string; targetId: string; closed: PscInfo[] }[] = [];
  if (table.size === 0) return out;
  for (const job of jobs) {
    const driver = job.delivery_driver_id;
    if (!driver || skip.driverIds.has(driver)) continue;
    if (job.last_assigned_plan_id != null) continue;
    if ((job.labels ?? []).some((l) => skip.labels.includes(l))) continue;
    const pickups = job.stops.filter((s) => s.stop_type_id === 1);
    const drops = job.stops.filter((s) => s.stop_type_id === 2);
    if (pickups.length !== 1 || drops.length !== 1) continue;
    const [pickup] = pickups;
    const [drop] = drops;
    const ps = pickup.stop_status_id ?? 0;
    if (ps < 1 || ps > 3) continue;                       // collected, or unknown
    if (drop.stop_status_id !== 1) continue;              // drop-off already under way
    if (!pickup.customer_id || skip.pickupIds.has(pickup.customer_id)) continue;
    const fromId = drop.customer_id ?? "";
    if (!table.has(fromId)) continue;
    const res = resolveOpenDropoff(table, fromId, nowMin, pickup.customer_id);
    if (res.id && res.id !== fromId) out.push({ job, fromId, targetId: res.id, closed: res.closed });
  }
  return out;
}
