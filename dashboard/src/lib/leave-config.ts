import { sheetCsvUrl, SHEET_GID } from "./sheets";
import { vnDate, vnMinutesSinceMidnight } from "./time";

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

let cache: { entries: LeaveEntry[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

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

function timeToMins(t: string | null): number {
  if (!t) return -1;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export async function loadLeaveEntries(): Promise<LeaveEntry[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.entries;

  try {
    const url = `${sheetCsvUrl(SHEET_GID.nghi_phep)}&_cb=${Date.now()}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const rows = parseCsv(await res.text());
    if (rows.length < 2) {
      cache = { entries: [], fetchedAt: Date.now() };
      return [];
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

    const entries: LeaveEntry[] = rows.slice(1).map((f) => {
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
    }).filter((e) => e.driver_id && e.leave_from);

    cache = { entries, fetchedAt: Date.now() };
    return entries;
  } catch {
    // On fetch failure keep stale cache if available; otherwise return empty
    return cache?.entries ?? [];
  }
}

export function isDriverOnLeave(
  driverId: string,
  entries: LeaveEntry[],
): { onLeave: boolean; driverName?: string; reason?: string; entry?: LeaveEntry } {
  const today = vnDate();
  const nowMins = vnMinutesSinceMidnight();

  for (const e of entries) {
    if (e.driver_id !== driverId) continue;
    const driverName = e.driver_name || undefined;

    if (e.loai_nghi === "Nghỉ nguyên buổi") {
      const to = e.leave_to ?? e.leave_from;
      if (today >= e.leave_from && today <= to) {
        return { onLeave: true, driverName, reason: `Nghỉ nguyên buổi ${e.leave_from}→${to}`, entry: e };
      }
    } else if (e.loai_nghi === "Nghỉ nửa buổi") {
      if (today === e.leave_from) {
        const start = timeToMins(e.gio_bat_dau);
        const end   = timeToMins(e.gio_ket_thuc);
        if (start >= 0 && end >= 0 && nowMins >= start && nowMins <= end) {
          return { onLeave: true, driverName, reason: `Nghỉ nửa buổi ${e.gio_bat_dau}–${e.gio_ket_thuc}`, entry: e };
        }
      }
    } else if (e.loai_nghi === "Nghỉ việc") {
      if (today >= e.leave_from) {
        return { onLeave: true, driverName, reason: `Nghỉ việc (từ ${e.leave_from})`, entry: e };
      }
    } else {
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
    }
  }

  return { onLeave: false };
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
    return nowMins >= start && nowMins <= end;
  });

  // De-dup by id so the same sub listed in two slots isn't a false clash.
  const ids = [...new Set(covering.map((s) => s.id))];
  if (ids.length === 0) return { status: "none" };
  if (ids.length > 1) return { status: "clash", subIds: ids };
  return { status: "ok", subId: ids[0] };
}
