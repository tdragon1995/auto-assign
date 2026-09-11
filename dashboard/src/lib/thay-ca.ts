import type { Mapping } from "./types";

export const THAY_CA_LABEL = "Thay ca";
export const THAY_CA_NOTE_PREFIX = "THAY_CA_V1:";
export const SWAP_NOTE_PREFIX = "THAY_CA_SWAP_V1:";
const DAY_MINUTES = 24 * 60;

export interface ThayCaMeta {
  recordKey: string;
  logicalKey: string;
  parentKey: string;
  sourceDriverId: string;
  sourceDate: string;
  sourceSubId: string;
  chain: string[];
  interval: number;
  sourceLeaveType?: string;
}

export interface SwapMeta {
  sourceKey: string;
  originalType: string;
  originalNote: string;
}

export interface ThayCaDesired {
  key: string;
  logicalKey: string;
  recordKey: string;
  parentKey: string;
  driver_id: string;
  driver_name: string;
  leave_from: string;
  leave_to: string;
  leave_from_hr: string;
  leave_to_hr: string;
  note: string;
  chain: string[];
}

interface Window {
  start: number;
  end: number;
}

function minute(value: string | null | undefined): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").trim());
  if (!m) return -1;
  const result = Number(m[1]) * 60 + Number(m[2]);
  return result >= 0 && result <= DAY_MINUTES ? result : -1;
}

function hhmm(value: number): string {
  const n = Math.max(0, Math.min(DAY_MINUTES, value));
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

function windows(start: string | null, end: string | null): Window[] {
  const from = minute(start);
  const to = minute(end);
  if (from < 0 || to < 0) return [{ start: 0, end: DAY_MINUTES }];
  if (from === to) return [];
  if (from < to) return [{ start: from, end: to }];
  return [
    { start: from, end: DAY_MINUTES },
    { start: 0, end: to },
  ];
}

function dutyWindows(driverId: string, mappings: readonly Mapping[]): Window[] {
  const result: Window[] = [];
  for (const mapping of mappings) {
    // Smart candidates are intentionally excluded. “Thay ca” is only created
    // when the substitute is committed to a fixed duty they would otherwise own.
    if (mapping.driver_id !== driverId) continue;
    result.push(...windows(
      mapping.shift_start ? `${String(mapping.shift_start.hours).padStart(2, "0")}:${String(mapping.shift_start.minutes).padStart(2, "0")}` : null,
      mapping.shift_end ? `${String(mapping.shift_end.hours).padStart(2, "0")}:${String(mapping.shift_end.minutes).padStart(2, "0")}` : null,
    ));
  }
  return result;
}

/** Fixed-duty windows shared by both drivers on the same configured route.
 * Leave rows do not carry a customer id, so a fixed source leave is compared
 * against the substitute only on routes both drivers actually own. */
function sharedDutyWindows(
  sourceDriverId: string,
  substituteId: string,
  mappings: readonly Mapping[],
): Window[] {
  const source = mappings.filter((mapping) => mapping.driver_id === sourceDriverId);
  const substitute = mappings.filter((mapping) => mapping.driver_id === substituteId);
  if (source.length === 0) return dutyWindows(substituteId, mappings);
  const substituteByCustomer = new Map<string, Mapping[]>();
  for (const mapping of substitute) {
    const rows = substituteByCustomer.get(mapping.customer_id) ?? [];
    rows.push(mapping);
    substituteByCustomer.set(mapping.customer_id, rows);
  }
  return source.flatMap((sourceMapping) => {
    const sourceWindows = windows(
      sourceMapping.shift_start ? `${String(sourceMapping.shift_start.hours).padStart(2, "0")}:${String(sourceMapping.shift_start.minutes).padStart(2, "0")}` : null,
      sourceMapping.shift_end ? `${String(sourceMapping.shift_end.hours).padStart(2, "0")}:${String(sourceMapping.shift_end.minutes).padStart(2, "0")}` : null,
    );
    return (substituteByCustomer.get(sourceMapping.customer_id) ?? []).flatMap((substituteMapping) => {
      const substituteWindows = windows(
        substituteMapping.shift_start ? `${String(substituteMapping.shift_start.hours).padStart(2, "0")}:${String(substituteMapping.shift_start.minutes).padStart(2, "0")}` : null,
        substituteMapping.shift_end ? `${String(substituteMapping.shift_end.hours).padStart(2, "0")}:${String(substituteMapping.shift_end.minutes).padStart(2, "0")}` : null,
      );
      return sourceWindows.flatMap((a) => substituteWindows.flatMap((b) => {
        const hit = intersection(a, b);
        return hit ? [hit] : [];
      }));
    });
  });
}

function merge(windowsToMerge: Window[]): Window[] {
  const sorted = [...windowsToMerge].sort((a, b) => a.start - b.start || a.end - b.end);
  const result: Window[] = [];
  for (const current of sorted) {
    const previous = result[result.length - 1];
    if (previous && current.start <= previous.end) {
      previous.end = Math.max(previous.end, current.end);
    } else if (current.start < current.end) {
      result.push({ ...current });
    }
  }
  return result;
}

function intersection(a: Window, b: Window): Window | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  // Strict inequality makes touching boundaries harmless.
  return start < end ? { start, end } : null;
}

function dateRange(from: string, to: string | null): string[] {
  const end = to || from;
  const result: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime()) || cursor > last) return [];
  while (cursor <= last) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function keyPart(value: string | null | undefined): string {
  return (value ?? "").trim() || "full";
}

export function sourceKey(
  driverId: string,
  date: string,
  from: string | null,
  to: string | null,
): string {
  return `leave|${driverId}|${date}|${keyPart(from)}-${keyPart(to)}`;
}

export function encodeThayCaNote(meta: ThayCaMeta): string {
  return `${THAY_CA_NOTE_PREFIX}${JSON.stringify(meta)}`;
}

export function parseThayCaNote(note: string | null | undefined): ThayCaMeta | null {
  const raw = (note ?? "").trim();
  if (!raw.startsWith(THAY_CA_NOTE_PREFIX)) return null;
  try {
    const value = JSON.parse(raw.slice(THAY_CA_NOTE_PREFIX.length)) as Partial<ThayCaMeta>;
    if (
      typeof value.recordKey !== "string" || typeof value.logicalKey !== "string" ||
      typeof value.parentKey !== "string" || typeof value.sourceDriverId !== "string" ||
      typeof value.sourceDate !== "string" || typeof value.sourceSubId !== "string" ||
      !Array.isArray(value.chain) || !value.chain.every((x) => typeof x === "string") ||
      typeof value.interval !== "number"
    ) return null;
    return value as ThayCaMeta;
  } catch {
    return null;
  }
}

export function encodeSwapNote(meta: SwapMeta): string {
  return `${SWAP_NOTE_PREFIX}${JSON.stringify(meta)}`;
}

export function parseSwapNote(note: string | null | undefined): SwapMeta | null {
  const raw = (note ?? "").trim();
  if (!raw.startsWith(SWAP_NOTE_PREFIX)) return null;
  try {
    const value = JSON.parse(raw.slice(SWAP_NOTE_PREFIX.length)) as Partial<SwapMeta>;
    if (typeof value.sourceKey !== "string" || typeof value.originalType !== "string" || typeof value.originalNote !== "string") return null;
    return value as SwapMeta;
  } catch {
    return null;
  }
}

/** Pure overlap calculation used by the reconciler and its offline tests. */
export function deriveThayCaRows(
  entries: readonly {
    driver_id: string;
    driver_name: string;
    leave_from: string;
    leave_to: string | null;
    gio_bat_dau: string | null;
    gio_ket_thuc: string | null;
    loai_nghi: string;
    subs: readonly { id: string; name: string; from: string | null; to: string | null }[];
    note?: string | null;
  }[],
  mappings: readonly Mapping[],
): ThayCaDesired[] {
  const desired: ThayCaDesired[] = [];
  for (const entry of entries) {
    if (!entry.driver_id || entry.loai_nghi === "Nghỉ việc" || entry.subs.length === 0) continue;
    const meta = parseThayCaNote(entry.note);
    const parentBase = meta?.recordKey ?? sourceKey(
      entry.driver_id, entry.leave_from, entry.gio_bat_dau, entry.gio_ket_thuc,
    );
    const chain = meta?.chain?.length ? meta.chain : [entry.driver_id];
    const parentWindow = windows(entry.gio_bat_dau, entry.gio_ket_thuc);
    for (const date of dateRange(entry.leave_from, entry.leave_to)) {
      for (const sub of entry.subs) {
        if (!sub.id || chain.includes(sub.id)) continue;
        const coverage = windows(sub.from ?? entry.gio_bat_dau, sub.to ?? entry.gio_ket_thuc);
        // Overnight windows are split before intersection so each generated
        // row remains a normal same-day leave row.
        const allHits = merge(coverage.flatMap((a) => sharedDutyWindows(entry.driver_id, sub.id, mappings).flatMap((b) =>
          parentWindow.flatMap((p) => {
            const dutyHit = intersection(b, p);
            const hit = dutyHit ? intersection(a, dutyHit) : null;
            return hit ? [hit] : [];
          }),
        )));
        const logicalKey = `thay|${parentBase}|${sub.id}`;
        allHits.forEach((hit, interval) => {
          const recordKey = `${logicalKey}|${interval}`;
          const childChain = [...chain, sub.id];
          const metaForRow: ThayCaMeta = {
            recordKey, logicalKey, parentKey: parentBase,
            sourceDriverId: entry.driver_id, sourceDate: date,
            sourceSubId: sub.id, chain: childChain, interval,
            sourceLeaveType: entry.loai_nghi,
          };
          desired.push({
            key: recordKey, logicalKey, recordKey, parentKey: parentBase,
            driver_id: sub.id, driver_name: sub.name, leave_from: date, leave_to: date,
            leave_from_hr: hhmm(hit.start), leave_to_hr: hhmm(hit.end),
            note: encodeThayCaNote(metaForRow), chain: childChain,
          });
        });
      }
    }
  }
  return desired;
}
