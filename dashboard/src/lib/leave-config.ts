import { Redis } from "@upstash/redis";
import { sheetCsvUrl, SHEET_GID } from "./sheets";
import { addDays, timeToMins, vnDate, vnMinutesSinceMidnight } from "./time";

/** The 3PL-express (Grab) booking proxy. When a substitute slot resolves to
 *  this UUID it means the leave is covered by a 3PL-express booking, NOT a real
 *  driver — so it must never be auto-assigned a job. Distinct from the parking
 *  PROXY_DRIVER_ID and the duplicate-reject proxy. */
export const PROXY_3PL_DRIVER_ID = "6437bace-6578-11f1-9378-fa163ee8d8ac";

/** One substitute slot on a leave row. `id` comes from the sheet's
 *  xlookup(name) formula; `name` is a supervisor-facing label only — the
 *  authoritative name is read from Cartrack's assign response. */
export interface SubEntry {
  id: string;
  name: string;
  from: string | null; // HH:MM — daily coverage window start
  to: string | null;   // HH:MM — daily coverage window end
}

export interface LeaveEntry {
  driver_id: string;
  driver_name: string;
  loai_nghi: string;
  leave_from: string;       // YYYY-MM-DD (for nghỉ việc: already +1 day)
  leave_to: string | null;  // YYYY-MM-DD
  gio_bat_dau: string | null; // HH:MM
  gio_ket_thuc: string | null;
  subs: SubEntry[];         // substitutes covering this driver's leave (0–4)
}

// Two-tier cache. L1 is a per-instance in-memory copy (zero network on a warm
// lambda — keeps the assign engine's hot path fast). L2 is a shared Redis copy
// so a *cold* instance (every /api/leave-status tap lands on one) reads the
// parsed roster back instead of re-fetching + re-parsing the 68 KB sheet over
// TLS. Same 5-min freshness on both. The Redis blob is the slimmed LeaveEntry[],
// so it's far smaller than the raw CSV (drops scheduled_trips/note).
let cache: { entries: LeaveEntry[]; invalid: InvalidLeaveRow[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;
const REDIS_KEY = "leave:v1:entries";

/**
 * 4 hours, up from 5 minutes — a BACKSTOP, not the freshness mechanism.
 *
 * This TTL never controlled how fresh leave is. It controlled how often the Leave Status
 * sheet was DOWNLOADED, and that download is the entire cost of this module. Measured
 * 2026-08-11: the sheet is 91.7 KB / 454 entries and fetching it costs ~150ms of Active
 * CPU (TLS to Google plus transfer); parsing it is below measurement resolution. At 5
 * minutes the key expired ~204 times across a working day — ~30s/day of CPU re-downloading
 * a year of leave records to answer a question whose response is 2.7 KB and whose data
 * changes a few times a day. At 4 hours it is ~4 downloads/day.
 *
 * Freshness comes from invalidation, not the clock, and both real paths are covered:
 *   - Leave is normally filed days ahead through the app, which calls
 *     invalidateLeaveCache (now awaited) and is visible at once.
 *   - A manual row goes in with the admin pressing Refresh, which is ?fresh=1 and bypasses
 *     both tiers outright.
 *   - CACHE_TTL_MS (per-process, still 5 min) bounds how long ANOTHER instance serves its
 *     own copy after someone else invalidates, so this value does not slow propagation.
 *
 * The TTL therefore only matters if an invalidation is lost AND nobody refreshes. It is
 * finite rather than absent for exactly that case, and 4 hours keeps such a lapse inside
 * the working day it happened in.
 */
const REDIS_TTL_S = 4 * 60 * 60;

function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/** Drop both cache tiers so the next load re-reads the sheet. Called after every write
 *  through the app (/api/nghi-phep, /api/leave-status POST), and by the dashboard Refresh
 *  path via ?fresh=1.
 *
 *  AWAITED, where it used to be `void redis.del(...)`. That was defensible while the TTL
 *  was 5 minutes — the old comment argued a missed delete "never serves stale" because a
 *  following ?fresh=1 load overwrites the key. Both halves of that are shaky: nothing
 *  guarantees a ?fresh=1 follows, and a serverless instance can be torn down the moment it
 *  returns its response, so a fire-and-forget DELETE may never reach Redis at all. With the
 *  TTL now measured in hours rather than minutes, a lost delete is the difference between
 *  leave appearing at once and leave appearing after lunch — so it is worth the ~10ms to
 *  know it landed. */
export async function invalidateLeaveCache(): Promise<void> {
  cache = null;
  const redis = getRedis();
  if (!redis) return;
  try { await redis.del(REDIS_KEY); } catch { /* best-effort; the TTL is the backstop */ }
}

function parseField(f: string | undefined): string {
  return (f ?? "").trim();
}

// Full CSV tokenizer (RFC-4180-ish): handles quoted fields containing commas,
// escaped quotes ("") AND embedded newlines. A line-by-line parser is unsafe
// here because scheduled_trips/note cells span multiple lines — and they sit
// BEFORE the substitute columns, so a naive split would shift every sub field.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ",") {
      row.push(cur); cur = "";
    } else if (ch === "\r") {
      /* ignore CR */
    } else if (ch === "\n") {
      row.push(cur); rows.push(row); row = []; cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur !== "" || row.length > 0) { row.push(cur); rows.push(row); }
  return rows;
}

/** One leave entry as it applies to a specific calendar date, for display
 *  (dashboard "Cần xử lý" leave-status panel) — not tied to the current clock
 *  the way `isDriverOnLeave` is, so "on leave tomorrow" can be listed today. */
export interface LeaveOnDate {
  driver_id: string;
  driver_name: string;
  loai_nghi: string;
  /** leave_from of the underlying row (YYYY-MM-DD). For "Nghỉ việc" this is
   *  the first day off (last working day + 1) — shown as date context. */
  leave_from: string;
  /** "HH:MM–HH:MM" for a half-day/windowed entry, null for a full day. */
  timeLabel: string | null;
  subs: SubEntry[];
  /** True when the sheet has MORE THAN ONE row for this driver+window on this
   *  date — a data-entry mistake (usually one blank row + one the supervisor
   *  filled the sub into). We collapse to the best-covered row so the engine
   *  still works, but flag it so the panel can prompt a sheet cleanup. */
  duplicate: boolean;
}

/**
 * Whether one leave entry covers `date`, and (for a partial day) the window
 * label to show. This is the single source of truth for the per-type date
 * rules; `leaveEntriesOnDate` builds on it. It deliberately matches the
 * coverage decisions in {@link isDriverOnLeave} so the dashboard panel and the
 * assign engine never disagree about who is off on a given day:
 *
 * - Half-day (`Nghỉ nửa buổi`) with a blank/invalid hour window → NOT covered
 *   (the engine's half-day branch also ignores such a row entirely), so a
 *   mistyped half-day never renders as a full-day absence.
 * - Unlabeled manual row with a blank/invalid window → covered full-day, same
 *   as the engine's else-branch.
 *
 * `timeLabel` is "HH:MM–HH:MM" for a windowed leave, or null for a full day.
 * Note this is date-only coverage: the engine additionally gates a windowed
 * leave on the *current* time; the panel shows the day's schedule regardless.
 */
function coverageOnDate(
  e: LeaveEntry,
  date: string,
): { covers: boolean; timeLabel: string | null } {
  const NONE = { covers: false, timeLabel: null };
  const windowLabel = (): string | null => {
    const start = timeToMins(e.gio_bat_dau);
    const end = timeToMins(e.gio_ket_thuc);
    return start >= 0 && end > start ? `${e.gio_bat_dau}–${e.gio_ket_thuc}` : null;
  };

  if (e.loai_nghi === "Nghỉ nguyên buổi") {
    const to = e.leave_to ?? e.leave_from;
    return date >= e.leave_from && date <= to ? { covers: true, timeLabel: null } : NONE;
  }
  if (e.loai_nghi === "Nghỉ nửa buổi") {
    if (date !== e.leave_from) return NONE;
    const label = windowLabel();
    return label ? { covers: true, timeLabel: label } : NONE;
  }
  if (e.loai_nghi === "Nghỉ việc") {
    // Engine skips resigned drivers from leave_from onward; the 7-day display
    // cap is applied by the caller (leaveEntriesOnDate), not here.
    return date >= e.leave_from ? { covers: true, timeLabel: null } : NONE;
  }
  // Unlabeled manual row: date range + optional window; blank window = full day.
  const to = e.leave_to ?? e.leave_from;
  if (date < e.leave_from || date > to) return NONE;
  return { covers: true, timeLabel: windowLabel() };
}

/** All leave entries active on `date` (YYYY-MM-DD), for the dashboard panel. */
/**
 * A leave row the loader had to THROW AWAY: the sheet's `driver_id` is an
 * xlookup on the driver name, and when it resolves to nothing the row cannot be
 * tied to a driver, so it reaches neither the panel nor the engine.
 *
 * That silence is the problem. A blank id makes real leave invisible — the
 * dashboard shows the driver as covered (or absent entirely) and the engine goes
 * on assigning them. Field case 2026-08-19: Huỳnh Nhật Tân was off 15:00–19:00
 * with no substitute and nothing anywhere said so, because that one cell was
 * empty while his morning row resolved fine.
 *
 * These are surfaced for a human to repair IN THE SHEET. They are deliberately
 * NOT recovered by name and fed to the engine: that would change who the engine
 * believes is working, mid-day, off the back of a cell that is already wrong.
 */
export interface InvalidLeaveRow {
  driver_name: string;
  loai_nghi: string;
  leave_from: string;
  leave_to: string | null;
  /** "HH:MM–HH:MM" when the row carries a usable window, else null. */
  timeLabel: string | null;
  /** Whether the row names a substitute — an uncovered dropped row is worse. */
  hasSub: boolean;
}

/** Dropped rows whose date range covers `date`. Same range rule as an unlabeled
 *  row in coverageOnDate; we cannot do better without the id these rows lack. */
export function invalidLeaveRowsOnDate(date: string, rows: InvalidLeaveRow[]): InvalidLeaveRow[] {
  return rows.filter((r) => {
    const to = r.leave_to || r.leave_from;
    return !!r.leave_from && r.leave_from <= date && date <= to;
  });
}

export function leaveEntriesOnDate(date: string, entries: LeaveEntry[]): LeaveOnDate[] {
  const raw: LeaveOnDate[] = [];
  for (const e of entries) {
    if (e.loai_nghi === "Nghỉ việc") {
      // Resigned drivers: the engine skips them forever, but the panel only
      // flags the transition — the day before the first day off (their last
      // working day) through the day after — then they drop off. leave_from is
      // already last_working_day + 1 (see /api/nghi-phep). addDays is throw-safe,
      // so a malformed leave_from just fails this range instead of 500-ing.
      if (date >= addDays(e.leave_from, -1) && date <= addDays(e.leave_from, 1)) {
        raw.push({
          driver_id: e.driver_id, driver_name: e.driver_name, loai_nghi: e.loai_nghi,
          leave_from: e.leave_from, timeLabel: null, subs: e.subs, duplicate: false,
        });
      }
      continue;
    }
    const cov = coverageOnDate(e, date);
    if (!cov.covers) continue;
    raw.push({
      driver_id: e.driver_id,
      driver_name: e.driver_name,
      loai_nghi: e.loai_nghi,
      leave_from: e.leave_from,
      timeLabel: cov.timeLabel,
      subs: e.subs,
      duplicate: false,
    });
  }

  // Collapse per driver + window: the sheet can carry a duplicate row for the
  // same driver+window (e.g. one filled with a sub, one left blank), which would
  // otherwise show the same slot twice — once covered, once "Chưa có người
  // thay". Keep the most-covered row so the substitute wins; genuinely different
  // windows (split-shift: morning vs afternoon) keep distinct keys and survive.
  // Count how many raw rows land on each key: >1 means the sheet has a redundant
  // duplicate the supervisor should delete — flag the kept row so the panel can
  // say so (isDriverOnLeave applies the same "most subs wins" collapse, so the
  // engine already assigns correctly; this is purely a data-hygiene prompt).
  const byKey = new Map<string, LeaveOnDate>();
  const countByKey = new Map<string, number>();
  for (const r of raw) {
    const key = `${r.driver_id}|${r.timeLabel ?? "full"}`;
    countByKey.set(key, (countByKey.get(key) ?? 0) + 1);
    const kept = byKey.get(key);
    if (!kept || r.subs.length > kept.subs.length) byKey.set(key, r);
  }
  for (const [key, entry] of byKey) {
    if ((countByKey.get(key) ?? 0) > 1) entry.duplicate = true;
  }
  return [...byKey.values()];
}

/** Two coverage windows on a shared date conflict when: either side is a full
 *  day (null → covers everything), or the windows actually overlap. A shared
 *  boundary (08:00–12:00 vs 12:00–16:00) does NOT overlap — same half-open
 *  convention as the coverage/substitute checks — so two adjacent half-days
 *  are allowed. */
function windowsConflict(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return true;
  const [as, ae] = a.split("–");
  const [bs, be] = b.split("–");
  return timeToMins(as) < timeToMins(be) && timeToMins(bs) < timeToMins(ae);
}

/** The concrete dates a candidate submission covers, bounded. Resignation is
 *  open-ended, so we probe only its start day and rely on the resignation-vs-
 *  resignation short-circuit in findLeaveConflict for the rest. */
function candidateDates(c: LeaveEntry): string[] {
  if (c.loai_nghi === "Nghỉ việc") return [c.leave_from];
  const to = c.leave_to ?? c.leave_from;
  const out: string[] = [];
  for (let d = c.leave_from, i = 0; d <= to && i < 366; d = addDays(d, 1), i++) out.push(d);
  return out.length ? out : [c.leave_from];
}

/**
 * First existing leave for the same driver that clashes with `candidate`, or
 * null if the submission is genuinely new. Used by /api/nghi-phep to block
 * duplicate/overlapping leave before it's written.
 *
 * Clash = same driver AND, on some shared date, both cover it with conflicting
 * windows ({@link windowsConflict}). A resignation is treated specially: a
 * driver resigns once, so any existing "Nghỉ việc" clashes with a new one
 * regardless of dates (their date order can hide the overlap otherwise).
 */
export function findLeaveConflict(candidate: LeaveEntry, existing: LeaveEntry[]): LeaveEntry | null {
  const same = existing.filter((e) => e.driver_id && e.driver_id === candidate.driver_id);
  if (candidate.loai_nghi === "Nghỉ việc") {
    const already = same.find((e) => e.loai_nghi === "Nghỉ việc");
    if (already) return already;
  }
  const dates = candidateDates(candidate);
  for (const e of same) {
    for (const d of dates) {
      const cCov = coverageOnDate(candidate, d);
      if (!cCov.covers) continue;
      const eCov = coverageOnDate(e, d);
      if (!eCov.covers) continue;
      if (windowsConflict(cCov.timeLabel, eCov.timeLabel)) return e;
    }
  }
  return null;
}

/** `force` (the ?fresh=1 / Refresh path) bypasses BOTH cache tiers and re-reads
 *  the sheet, then overwrites both — so a supervisor's edit shows at once on
 *  every instance, not just the one that handled the refresh. */
export async function loadLeaveEntries(force = false): Promise<LeaveEntry[]> {
  return (await loadLeaveSheet(force)).entries;
}

/** The rows loadLeaveEntries had to discard — see {@link InvalidLeaveRow}.
 *  Shares the cached parse, so asking for it costs nothing extra. */
export async function loadInvalidLeaveRows(force = false): Promise<InvalidLeaveRow[]> {
  return (await loadLeaveSheet(force)).invalid;
}

async function loadLeaveSheet(
  force = false,
): Promise<{ entries: LeaveEntry[]; invalid: InvalidLeaveRow[] }> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { entries: cache.entries, invalid: cache.invalid };
  }

  // L2: shared Redis copy. Skipped on force; failures fall through to the fetch.
  if (!force) {
    const redis = getRedis();
    if (redis) {
      try {
        // Values written before the invalid-row split are a bare array; read
        // them as "entries, nothing discarded" rather than throwing the cache
        // away on the deploy that changes the shape.
        const hit = await redis.get<LeaveEntry[] | { entries: LeaveEntry[]; invalid: InvalidLeaveRow[] }>(REDIS_KEY);
        if (hit) {
          const shaped = Array.isArray(hit) ? { entries: hit, invalid: [] } : hit;
          cache = { ...shaped, invalid: shaped.invalid ?? [], fetchedAt: Date.now() };
          return { entries: cache.entries, invalid: cache.invalid };
        }
      } catch { /* fall through to the sheet fetch */ }
    }
  }

  try {
    const url = `${sheetCsvUrl(SHEET_GID.nghi_phep)}&_cb=${Date.now()}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const rows = parseCsv(await res.text());
    if (rows.length < 2) {
      cache = { entries: [], invalid: [], fetchedAt: Date.now() };
      return { entries: [], invalid: [] };
    }

    // Header-keyed access — robust to column re-ordering/additions (the sub
    // blocks). First occurrence of each header name wins.
    const col: Record<string, number> = {};
    rows[0].forEach((h, i) => { const k = h.trim(); if (!(k in col)) col[k] = i; });
    const get = (f: string[], name: string): string => {
      const i = col[name];
      return i == null ? "" : parseField(f[i]);
    };

    const buildSub = (f: string[], n: number): SubEntry | null => {
      const id = get(f, `sub${n}_id`);
      if (!id) return null;
      return {
        id,
        name: get(f, `sub${n}_name`),
        from: get(f, `sub${n}_from`) || null,
        to:   get(f, `sub${n}_to`) || null,
      };
    };

    const parsed: LeaveEntry[] = rows.slice(1).map((f) => {
      const subs: SubEntry[] = [];
      for (let n = 1; n <= 4; n++) { const s = buildSub(f, n); if (s) subs.push(s); }
      return {
        driver_id:    get(f, "driver_id"),
        driver_name:  get(f, "driver"),
        loai_nghi:    get(f, "Loại Nghỉ"),
        leave_from:   get(f, "leave_from"),
        leave_to:     get(f, "leave_to") || null,
        gio_bat_dau:  get(f, "leave_from_hr") || null,
        gio_ket_thuc: get(f, "leave_to_hr") || null,
        subs,
      };
      // NOTE: do NOT require loai_nghi here. Many rows are typed straight into
      // the sheet with a date + time window but a blank "Loại Nghỉ" cell; those
      // are still real leave and must reach isDriverOnLeave (see its else-branch).
    });

    const entries = parsed.filter((e) => e.driver_id && e.leave_from);

    // Rows that look like real leave — a named driver and a start date — but
    // carry no resolved driver_id. They stay OUT of `entries` (unchanged
    // behaviour for the engine) and are reported for a sheet repair instead of
    // vanishing without trace. A row with neither a name nor a date is just an
    // empty sheet row and is not worth reporting.
    const invalid: InvalidLeaveRow[] = parsed
      .filter((e) => !e.driver_id && e.leave_from && e.driver_name)
      .map((e) => {
        const start = timeToMins(e.gio_bat_dau);
        const end = timeToMins(e.gio_ket_thuc);
        return {
          driver_name: e.driver_name,
          loai_nghi: e.loai_nghi,
          leave_from: e.leave_from,
          leave_to: e.leave_to,
          timeLabel: start >= 0 && end > start ? `${e.gio_bat_dau}–${e.gio_ket_thuc}` : null,
          hasSub: e.subs.length > 0,
        };
      });

    cache = { entries, invalid, fetchedAt: Date.now() };
    // Write-behind to L2 — but only a non-empty roster. A transient bad read
    // that parses to zero entries must never be shared to every instance (it
    // would read back as "nobody on leave"); leave that failure per-instance.
    if (entries.length) {
      const redis = getRedis();
      if (redis) {
        try { await redis.set(REDIS_KEY, { entries, invalid }, { ex: REDIS_TTL_S }); } catch { /* cache write is best-effort */ }
      }
    }
    return { entries, invalid };
  } catch {
    // On fetch failure keep stale cache if available; otherwise return empty
    return { entries: cache?.entries ?? [], invalid: cache?.invalid ?? [] };
  }
}

/** Whether ONE entry puts the driver on leave right now (today + current clock),
 *  or null if it doesn't apply. Split out of {@link isDriverOnLeave} so that
 *  function can weigh several matching rows against each other instead of
 *  being forced to take the first one it walks into. */
function leaveMatchNow(
  e: LeaveEntry,
  today: string,
  nowMins: number,
): { onLeave: true; driverName?: string; reason: string; entry: LeaveEntry } | null {
  const driverName = e.driver_name || undefined;

  if (e.loai_nghi === "Nghỉ nguyên buổi") {
    const to = e.leave_to ?? e.leave_from;
    if (today >= e.leave_from && today <= to) {
      return { onLeave: true, driverName, reason: `Nghỉ nguyên buổi ${e.leave_from}→${to}`, entry: e };
    }
    return null;
  }
  if (e.loai_nghi === "Nghỉ nửa buổi") {
    if (today === e.leave_from) {
      const start = timeToMins(e.gio_bat_dau);
      const end   = timeToMins(e.gio_ket_thuc);
      if (start >= 0 && end >= 0 && nowMins >= start && nowMins <= end) {
        return { onLeave: true, driverName, reason: `Nghỉ nửa buổi ${e.gio_bat_dau}–${e.gio_ket_thuc}`, entry: e };
      }
    }
    return null;
  }
  if (e.loai_nghi === "Nghỉ việc") {
    if (today >= e.leave_from) {
      return { onLeave: true, driverName, reason: `Nghỉ việc (từ ${e.leave_from})`, entry: e };
    }
    return null;
  }
  // Unlabeled / manually-typed leave (blank "Loại Nghỉ"): a date range with
  // an optional daily time window. driver_id is resolved from the name by
  // the sheet's xlookup() formula. On-leave today when within the date range;
  // honour the [gio_bat_dau, gio_ket_thuc] window when one is given, else
  // treat as full-day (covers blank hours and the 00:00–00:00 sentinel).
  const to = e.leave_to ?? e.leave_from;
  if (today >= e.leave_from && today <= to) {
    const start = timeToMins(e.gio_bat_dau);
    const end   = timeToMins(e.gio_ket_thuc);
    const hasWindow = start >= 0 && end > start;
    if (!hasWindow) {
      return { onLeave: true, driverName, reason: `Nghỉ cả ngày ${e.leave_from}${to !== e.leave_from ? `→${to}` : ""}`, entry: e };
    }
    if (nowMins >= start && nowMins <= end) {
      return { onLeave: true, driverName, reason: `Nghỉ ${e.gio_bat_dau}–${e.gio_ket_thuc}`, entry: e };
    }
  }
  return null;
}

export function isDriverOnLeave(
  driverId: string,
  entries: LeaveEntry[],
): { onLeave: boolean; driverName?: string; reason?: string; entry?: LeaveEntry } {
  const today = vnDate();
  const nowMins = vnMinutesSinceMidnight();

  // The sheet routinely carries DUPLICATE rows for the same driver+day: one
  // typed by the requester (e.g. "Nghỉ phép", substitute columns left blank)
  // and one the supervisor fills the substitute into. Returning the first
  // match would report "no substitute" whenever the blank duplicate happens to
  // sort first — while the dashboard panel shows the sub, because
  // leaveEntriesOnDate already collapses duplicates on "most subs wins". The
  // engine and the panel must not disagree about who is covering, so apply the
  // same preference here: among all rows that put this driver on leave right
  // now, keep the best-covered one. Ties keep the earliest row (stable).
  let best: ReturnType<typeof leaveMatchNow> = null;
  for (const e of entries) {
    if (e.driver_id !== driverId) continue;
    const m = leaveMatchNow(e, today, nowMins);
    if (!m) continue;
    if (!best || m.entry.subs.length > best.entry.subs.length) best = m;
  }

  return best ?? { onLeave: false };
}

/**
 * Resolve which substitute should cover an on-leave driver right now, mirroring
 * the fixed-path clash model: exactly one covering sub → assign; 2+ overlapping
 * → clash (flag, don't assign); none → no cover.
 *
 * Resolution is exactly one layer deep: driver on leave → use the named sub,
 * full stop. We do NOT check whether the sub is themselves on leave, and we do
 * NOT chain to the sub's own sub — the supervisor manages those cases on the
 * sheet. The only subs dropped here are the 3PL-express proxy (never a real
 * assignee) and any whose coverage window doesn't include now. A blank sub
 * window inherits the leave's own window (leave_from_hr–leave_to_hr); a full-day
 * leave with no hour window means the sub covers the whole day.
 *
 * The coverage window is half-open `(from, to]` — start exclusive, end inclusive —
 * the same convention as the config-sheet shift check ({@link isDriverOnShift}).
 * So back-to-back sub windows that share a boundary (e.g. Vấn …–15:00 then
 * Khiết 15:00–…) don't both match at the boundary minute: the earlier window
 * (whose `to` = the boundary) owns it, and the later one starts the minute after.
 * That removes the shared-boundary false-CLASH without needing a 1-minute offset.
 */
export function resolveSubstitute(
  entry: LeaveEntry,
):
  | { status: "ok"; subId: string }
  | { status: "clash"; subIds: string[] }
  | { status: "none" } {
  const nowMins = vnMinutesSinceMidnight();

  const covering = entry.subs.filter((s) => {
    if (!s.id) return false;
    if (s.id === PROXY_3PL_DRIVER_ID) return false; // 3PL-express proxy, never a real assignee
    let start = timeToMins(s.from);
    let end   = timeToMins(s.to);
    let hasWindow = start >= 0 && end > start;
    if (!hasWindow) {
      // Blank sub window → inherit the leave's own window (leave_from_hr–leave_to_hr).
      start = timeToMins(entry.gio_bat_dau);
      end   = timeToMins(entry.gio_ket_thuc);
      hasWindow = start >= 0 && end > start;
    }
    if (!hasWindow) return true; // leave is full-day (no hour window) → covers all day
    return nowMins > start && nowMins <= end; // half-open: start exclusive, end inclusive
  });

  // De-dup by id so the same sub listed in two slots isn't a false clash.
  const ids = [...new Set(covering.map((s) => s.id))];
  if (ids.length === 0) return { status: "none" };
  if (ids.length > 1) return { status: "clash", subIds: ids };
  return { status: "ok", subId: ids[0] };
}
