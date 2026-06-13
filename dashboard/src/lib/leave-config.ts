import { sheetCsvUrl, SHEET_GID } from "./sheets";
import { vnDate, vnMinutesSinceMidnight } from "./time";

export interface LeaveEntry {
  driver_id: string;
  driver_name: string;
  loai_nghi: string;
  leave_from: string;       // YYYY-MM-DD (for nghỉ việc: already +1 day)
  leave_to: string | null;  // YYYY-MM-DD
  gio_bat_dau: string | null; // HH:MM
  gio_ket_thuc: string | null;
}

let cache: { entries: LeaveEntry[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

function parseField(f: string | undefined): string {
  return (f ?? "").trim();
}

// Minimal CSV line parser (handles double-quoted fields)
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQ = false;
  for (const ch of line) {
    if (inQ) {
      if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === '"') { inQ = true; }
      else if (ch === ',') { fields.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
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

    const text = await res.text();
    const lines = text
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.trim());

    // First line is header — skip it
    const entries: LeaveEntry[] = lines.slice(1).map((line) => {
      const f = parseCsvLine(line);
      // Column order matches what /api/nghi-phep writes:
      // [0] Timestamp  [1] driver_id  [2] driver_name  [3] Loại nghỉ
      // [4] leave_from [5] leave_to   [6] gio_bat_dau  [7] gio_ket_thuc
      return {
        driver_id:   parseField(f[1]),
        driver_name: parseField(f[2]),
        loai_nghi:   parseField(f[3]),
        leave_from: parseField(f[4]),
        leave_to:   parseField(f[5]) || null,
        gio_bat_dau:  parseField(f[6]) || null,
        gio_ket_thuc: parseField(f[7]) || null,
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
): { onLeave: boolean; driverName?: string; reason?: string } {
  const today = vnDate();
  const nowMins = vnMinutesSinceMidnight();

  for (const e of entries) {
    if (e.driver_id !== driverId) continue;
    const driverName = e.driver_name || undefined;

    if (e.loai_nghi === "Nghỉ nguyên buổi") {
      const to = e.leave_to ?? e.leave_from;
      if (today >= e.leave_from && today <= to) {
        return { onLeave: true, driverName, reason: `Nghỉ nguyên buổi ${e.leave_from}→${to}` };
      }
    } else if (e.loai_nghi === "Nghỉ nửa buổi") {
      if (today === e.leave_from) {
        const start = timeToMins(e.gio_bat_dau);
        const end   = timeToMins(e.gio_ket_thuc);
        if (start >= 0 && end >= 0 && nowMins >= start && nowMins <= end) {
          return { onLeave: true, driverName, reason: `Nghỉ nửa buổi ${e.gio_bat_dau}–${e.gio_ket_thuc}` };
        }
      }
    } else if (e.loai_nghi === "Nghỉ việc") {
      if (today >= e.leave_from) {
        return { onLeave: true, driverName, reason: `Nghỉ việc (từ ${e.leave_from})` };
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
          return { onLeave: true, driverName, reason: `Nghỉ cả ngày ${e.leave_from}${to !== e.leave_from ? `→${to}` : ""}` };
        }
        if (nowMins >= start && nowMins <= end) {
          return { onLeave: true, driverName, reason: `Nghỉ ${e.gio_bat_dau}–${e.gio_ket_thuc}` };
        }
      }
    }
  }

  return { onLeave: false };
}
