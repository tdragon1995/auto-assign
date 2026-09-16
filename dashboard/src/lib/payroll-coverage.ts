import { Redis } from "@upstash/redis";

export interface PayrollCoverage {
  month: string;
  from: string;
  to: string;
  days_expected: number;
  days_reconciled: number;
  failed_days: string[];
  source_exceptions: number;
  unpriced_jobs: number;
  attendance_exceptions: number;
  complete: boolean;
  ready_for_approval: boolean;
  reconciled_at: string;
  report_id: string;
}

const key = (month: string) => `payroll:coverage:v1:${month}`;

function redis(): Redis | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

export async function getPayrollCoverage(month: string): Promise<PayrollCoverage | null> {
  const r = redis();
  if (!r) return null;
  try {
    const raw = await r.get<PayrollCoverage | string>(key(month));
    if (!raw) return null;
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as PayrollCoverage;
  } catch {
    return null;
  }
}

export async function setPayrollCoverage(value: PayrollCoverage): Promise<void> {
  const r = redis();
  if (!r) throw new Error("Redis is required to publish payroll coverage");
  await r.set(key(value.month), JSON.stringify(value));
}

/** A later change to an audited day invalidates the old readiness claim. */
export async function invalidatePayrollCoverageForDate(date: string): Promise<void> {
  const monthDate = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  if (Number(date.slice(8, 10)) >= 15) monthDate.setUTCMonth(monthDate.getUTCMonth() + 1);
  const month = monthDate.toISOString().slice(0, 7);
  const r = redis();
  if (!r) return;
  // A Redis read failure must stop a changing archive: otherwise an old ready
  // marker could survive an outage and reappear against different payroll rows.
  const raw = await r.get<PayrollCoverage | string>(key(month));
  const coverage = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) as PayrollCoverage : null;
  if (coverage) await setPayrollCoverage({ ...coverage, complete: false, ready_for_approval: false, days_reconciled: 0 });
}

export function missingPayrollCoverage(month: string, from: string, to: string): PayrollCoverage {
  const days = Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1);
  return {
    month, from, to, days_expected: days, days_reconciled: 0, failed_days: [],
    source_exceptions: 0, unpriced_jobs: 0, attendance_exceptions: 0,
    complete: false, ready_for_approval: false, reconciled_at: "", report_id: "",
  };
}
