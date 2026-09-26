import { timeToMins } from "./time";

/** Values as they were when the supervisor opened a config rule. */
export interface ConfigRowSnapshot {
  driver: string;
  start: string;
  end: string;
  dropoff: string;
}

export interface ConfigRowAt extends ConfigRowSnapshot {
  row: number;
  pickup: string;
}

export function parseConfigRowSnapshot(value: unknown): ConfigRowSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if ([row.driver, row.start, row.end, row.dropoff].some((cell) => typeof cell !== "string")) return null;
  return { driver: row.driver as string, start: row.start as string, end: row.end as string, dropoff: row.dropoff as string };
}

const text = (value: string) => value.trim();
const sameTime = (a: string, b: string) => {
  const left = timeToMins(a), right = timeToMins(b);
  return Number.isFinite(left) && left >= 0 && Number.isFinite(right) && right >= 0
    ? left === right
    : text(a) === text(b);
};

export function sameConfigRow(row: ConfigRowAt, pickup: string, expected: ConfigRowSnapshot): boolean {
  return text(row.pickup) === text(pickup)
    && text(row.driver) === text(expected.driver)
    && sameTime(row.start, expected.start)
    && sameTime(row.end, expected.end)
    && text(row.dropoff) === text(expected.dropoff);
}

/** A moved rule is safe to edit only when its old values identify one live row. */
export function findUniqueConfigRow(
  rows: readonly ConfigRowAt[],
  pickup: string,
  expected: ConfigRowSnapshot,
): { row: number } | { reason: "missing" | "ambiguous" } {
  const matches = rows.filter((row) => sameConfigRow(row, pickup, expected));
  if (matches.length === 1) return { row: matches[0].row };
  return { reason: matches.length ? "ambiguous" : "missing" };
}
