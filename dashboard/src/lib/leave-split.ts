import { timeToMins } from "./time";

export const LEAVE_SPLIT_NOTE_PREFIX = "LEAVE_SPLIT_V1:";
const DAY_MINUTES = 24 * 60;

export interface LeaveSplitBlock {
  name: string;
  from: string | null;
  to: string | null;
}

export interface LeaveSplitPart {
  from: string;
  to: string;
  sub: LeaveSplitBlock | null;
}

export interface LeaveSplitMeta {
  operationKey: string;
  sourceKey: string;
  partKey: string;
  originalNote: string;
}

export class LeaveSplitValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaveSplitValidationError";
  }
}

function minute(value: string | null): number {
  const raw = (value ?? "").trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) return -1;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) return -1;
  const result = timeToMins(raw);
  return result >= 0 && result <= DAY_MINUTES ? result : -1;
}

function hhmm(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

/**
 * Turn the editor's substitute blocks into the exact leave rows that will be
 * saved. Full-day leave is treated as 00:00–24:00 so uncovered edges remain
 * real leave instead of disappearing when only the working shift is staffed.
 */
export function buildLeaveSplit(
  sourceFrom: string | null,
  sourceTo: string | null,
  blocks: readonly LeaveSplitBlock[],
): LeaveSplitPart[] {
  if (blocks.length < 2 || blocks.length > 3) {
    throw new LeaveSplitValidationError("Chia ca cần 2–3 dòng người thay");
  }
  const start = sourceFrom ? minute(sourceFrom) : 0;
  const end = sourceTo ? minute(sourceTo) : DAY_MINUTES;
  if (start < 0 || end <= start) {
    throw new LeaveSplitValidationError("Khung giờ nghỉ gốc không hợp lệ");
  }

  const chosen = blocks.map((block) => {
    const name = block.name.trim();
    const from = (block.from ?? "").trim();
    const to = (block.to ?? "").trim();
    if (!name || !from || !to) {
      throw new LeaveSplitValidationError("Hoàn tất người thay, giờ bắt đầu và giờ kết thúc cho mọi ca");
    }
    const fromMinutes = minute(from);
    const toMinutes = minute(to);
    if (fromMinutes < 0 || toMinutes <= fromMinutes) {
      throw new LeaveSplitValidationError(`Khung giờ không hợp lệ: ${from || "--:--"}–${to || "--:--"}`);
    }
    if (fromMinutes < start || toMinutes > end) {
      throw new LeaveSplitValidationError(
        `Ca ${from}–${to} nằm ngoài giờ nghỉ ${hhmm(start)}–${hhmm(end)}`,
      );
    }
    return { name, from: hhmm(fromMinutes), to: hhmm(toMinutes), fromMinutes, toMinutes };
  }).sort((a, b) => a.fromMinutes - b.fromMinutes || a.toMinutes - b.toMinutes);

  for (let i = 1; i < chosen.length; i++) {
    if (chosen[i].fromMinutes < chosen[i - 1].toMinutes) {
      throw new LeaveSplitValidationError(
        `Khung giờ bị chồng: ${chosen[i - 1].from}–${chosen[i - 1].to} và ${chosen[i].from}–${chosen[i].to}`,
      );
    }
  }

  const result: LeaveSplitPart[] = [];
  let cursor = start;
  for (const block of chosen) {
    if (cursor < block.fromMinutes) {
      result.push({ from: hhmm(cursor), to: block.from, sub: null });
    }
    result.push({
      from: block.from,
      to: block.to,
      sub: { name: block.name, from: block.from, to: block.to },
    });
    cursor = block.toMinutes;
  }
  if (cursor < end) result.push({ from: hhmm(cursor), to: hhmm(end), sub: null });
  return result;
}

function hash(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x85ebca6b);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

/** Stable for the same source identity and requested result, including retries. */
export function leaveSplitOperationKey(
  driverId: string,
  date: string,
  sourceFrom: string | null,
  sourceTo: string | null,
  parts: readonly LeaveSplitPart[],
): string {
  const source = `${driverId}|${date}|${sourceFrom || "full"}-${sourceTo || "full"}`;
  const desired = parts.map((part) => `${part.from}-${part.to}:${part.sub?.name ?? ""}`).join("|");
  return `split|${source}|${hash(desired)}`;
}

export function encodeLeaveSplitNote(meta: LeaveSplitMeta): string {
  return `${LEAVE_SPLIT_NOTE_PREFIX}${JSON.stringify(meta)}`;
}

export function parseLeaveSplitNote(note: string | null | undefined): LeaveSplitMeta | null {
  const raw = (note ?? "").trim();
  if (!raw.startsWith(LEAVE_SPLIT_NOTE_PREFIX)) return null;
  try {
    const value = JSON.parse(raw.slice(LEAVE_SPLIT_NOTE_PREFIX.length)) as Partial<LeaveSplitMeta>;
    if (
      typeof value.operationKey !== "string" || typeof value.sourceKey !== "string" ||
      typeof value.partKey !== "string" || typeof value.originalNote !== "string"
    ) return null;
    return value as LeaveSplitMeta;
  } catch {
    return null;
  }
}

export function unwrapLeaveSplitNote(note: string | null | undefined): string {
  return parseLeaveSplitNote(note)?.originalNote ?? (note ?? "");
}

/** Keep split provenance while reconciliation changes the note it wraps. */
export function replaceSplitOriginalNote(existing: string | null | undefined, originalNote: string): string {
  const meta = parseLeaveSplitNote(existing);
  return meta ? encodeLeaveSplitNote({ ...meta, originalNote }) : originalNote;
}
