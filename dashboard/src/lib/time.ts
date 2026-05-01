const TZ = "Asia/Ho_Chi_Minh";

/** Current moment as a plain Date (identical to `new Date()`; use with vnDate/vnTimestamp/vnHoursMinutes). */
export function vnNow(): Date {
  return new Date();
}

/** "YYYY-MM-DD" for the given Date (default: now) in Saigon time. */
export function vnDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(d).slice(0, 10);
}

/** "YYYY-MM-DD HH:mm:ss" for the given Date (default: now) in Saigon time. */
export function vnTimestamp(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** Hours and minutes of the given Date (default: now) in Saigon time. */
export function vnHoursMinutes(d: Date = new Date()): { hours: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(d);
  const hours = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minutes = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return { hours, minutes };
}

/** Minutes since Saigon midnight for the given Date (default: now). */
export function vnMinutesSinceMidnight(d: Date = new Date()): number {
  const { hours, minutes } = vnHoursMinutes(d);
  return hours * 60 + minutes;
}

/**
 * Parse a Cartrack timestamp ("YYYY-MM-DD HH:mm:ss" or ISO without TZ) as Saigon
 * local time. Returns an invalid Date if the input is empty or unparseable.
 */
export function parseVnTimestamp(ts: string | undefined | null): Date {
  if (!ts) return new Date(NaN);
  return new Date(ts.replace(" ", "T") + "+07:00");
}

/**
 * Build the standard `{from, to}` Saigon-day window for Cartrack JSON-RPC
 * filters. Defaults to today.
 */
export function vnDayWindow(date: string = vnDate()): { from: string; to: string } {
  return {
    from: `${date}T00:00:00+07:00`,
    to: `${date}T23:59:59+07:00`,
  };
}
