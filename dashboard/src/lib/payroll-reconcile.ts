import { employmentOf } from "./driver-label";
import { workedMinutes, hourPayFor, kmPayFor, type PayJob, type PayPunch } from "./pay";

export type StoredPayJob = PayJob & { id?: number; archived_at?: string };
export type StoredPayPunch = PayPunch & { id?: number; archived_at?: string };

export const payRowKey = (row: Pick<PayJob, "trip_date" | "job_id">) => `${row.trip_date}:${row.job_id}`;

export function payrollDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export function onlyPartTime<T extends { driver_name: string | null }>(rows: T[]): T[] {
  return rows.filter((row) => employmentOf(row.driver_name) === "part-time");
}

export interface RowDiff<T> {
  missing: T[];
  stale: T[];
  duplicates: string[];
  wrong_driver: Array<{ key: string; expected: string; stored: string }>;
  wrong_date: Array<{ job_id: number; expected: string; stored: string }>;
  changed: string[];
}

export function diffPayRows<T extends { trip_date: string; job_id: number; driver_id: string }>(
  expected: T[], stored: T[],
): RowDiff<T> {
  const duplicateKeys = (rows: T[]) => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const row of rows) {
      const key = payRowKey(row);
      if (seen.has(key)) dupes.add(key); else seen.add(key);
    }
    return [...dupes].sort();
  };
  const expectedByKey = new Map(expected.map((row) => [payRowKey(row), row]));
  const storedByKey = new Map(stored.map((row) => [payRowKey(row), row]));
  const missing = expected.filter((row) => !storedByKey.has(payRowKey(row)));
  const stale = stored.filter((row) => !expectedByKey.has(payRowKey(row)));
  const wrong_driver: RowDiff<T>["wrong_driver"] = [];
  const wrong_date: RowDiff<T>["wrong_date"] = [];
  const changed: string[] = [];
  const storedByJob = new Map(stored.map((row) => [row.job_id, row]));
  for (const [key, wanted] of expectedByKey) {
    const have = storedByKey.get(key);
    if (have && have.driver_id !== wanted.driver_id) {
      wrong_driver.push({ key, expected: wanted.driver_id, stored: have.driver_id });
    }
    if (have) {
      const normalize = (field: string, value: unknown): unknown => {
        if (value == null) return null;
        if (field.endsWith("_ts") && typeof value === "string") return Date.parse(value);
        if (field === "distance_km") return Number(value);
        return value;
      };
      const wantedFields = wanted as Record<string, unknown>;
      const haveFields = have as Record<string, unknown>;
      if (Object.keys(wantedFields).filter((field) => field !== "id" && field !== "archived_at")
        .some((field) => normalize(field, wantedFields[field]) !== normalize(field, haveFields[field]))) {
        changed.push(key);
      }
    }
  }
  for (const wanted of expected) {
    const have = storedByJob.get(wanted.job_id);
    if (have && have.trip_date !== wanted.trip_date) {
      wrong_date.push({ job_id: wanted.job_id, expected: wanted.trip_date, stored: have.trip_date });
    }
  }
  return { missing, stale, duplicates: [...new Set([...duplicateKeys(expected), ...duplicateKeys(stored)])], wrong_driver, wrong_date, changed };
}

export interface DriverAudit {
  driver_id: string;
  driver_name: string | null;
  jobs: number;
  km: number;
  unpriced_jobs: number;
  punches: number;
  worked_mins: number;
  open_in: number;
  stray_out: number;
  days_worked: number;
  hour_pay: number;
  km_pay: number;
  total_pay: number;
}

export function summarizeDrivers(jobs: PayJob[], punches: PayPunch[]): DriverAudit[] {
  const names = new Map<string, string | null>();
  for (const row of [...jobs, ...punches]) if (!names.has(row.driver_id) || row.driver_name) names.set(row.driver_id, row.driver_name);
  const out: DriverAudit[] = [];
  for (const [driver_id, driver_name] of names) {
    const mineJobs = jobs.filter((row) => row.driver_id === driver_id);
    const minePunches = punches.filter((row) => row.driver_id === driver_id);
    const byDay = new Map<string, PayPunch[]>();
    for (const punch of minePunches) {
      const list = byDay.get(punch.trip_date) ?? [];
      list.push(punch);
      byDay.set(punch.trip_date, list);
    }
    let worked_mins = 0;
    let open_in = 0;
    let stray_out = 0;
    for (const day of byDay.values()) {
      const worked = workedMinutes(day);
      worked_mins += worked.minutes;
      open_in += worked.open_in.length;
      stray_out += worked.stray_out.length;
    }
    const km = Math.round(mineJobs.reduce((sum, row) => sum + (row.distance_km ?? 0), 0) * 100) / 100;
    out.push({
      driver_id, driver_name, jobs: mineJobs.length,
      km,
      unpriced_jobs: mineJobs.filter((row) => row.distance_km == null).length,
      punches: minePunches.length, worked_mins, open_in, stray_out,
      days_worked: new Set([...mineJobs, ...minePunches].map((row) => row.trip_date)).size,
      hour_pay: hourPayFor(worked_mins), km_pay: kmPayFor(km),
      total_pay: hourPayFor(worked_mins) + kmPayFor(km),
    });
  }
  return out.sort((a, b) => (a.driver_name ?? "").localeCompare(b.driver_name ?? "", "vi"));
}
