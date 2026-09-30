import type { Config, Job, Mapping } from "./types";
import type { LeaveEntry } from "./leave-config";
import { parseLeaveCsv, isDriverOnLeave, resolveSubstitute, leaveEntriesOnDate } from "./leave-config";
import { dutyRows } from "./day-config";
import { findSmartMapping, getDriversOnDuty, resolveFixedDriver } from "./fixed-driver";
import { getCustomerIdFromJob, parsePickupWindowTime } from "./assign";
import { masterRuleRows } from "./master-store";
import { masterLeaveRows, leaveLegacyRow } from "./master-leave";
import { fetchSheetRows, sheetCsvUrl, SHEET_CONTRACT, SHEET_GID } from "./sheets";
import { getJobsByDate } from "./cartrack";
import { getRunLog } from "./smart-log-kv";
import { parseVnTimestamp, vnDate, vnIsSunday } from "./time";

const asConfig = (mappings: Mapping[]): Config => ({ mappings, unfinished: [], gaps: [], overlaps: [], branchRules: {}, parsedAt: "" });
export const effectiveRuleKey = (m: Mapping | undefined) => m && JSON.stringify([
  m.customer_id, m.dropoff_id, m.smart_driver_id.length ? "" : m.driver_id, m.smart_driver_id,
  m.shift_start, m.shift_end, m.alt_drop_off_id,
]);

function leaveFromRow(row: Record<string, string>): LeaveEntry {
  return {
    driver_id: row.driver_id ?? "", driver_name: row.driver ?? "", loai_nghi: row["Loại Nghỉ"] ?? "",
    leave_from: row.leave_from ?? "", leave_to: row.leave_to || null,
    gio_bat_dau: row.leave_from_hr || null, gio_ket_thuc: row.leave_to_hr || null,
    subs: [1, 2, 3, 4].filter(i => row[`sub${i}_id`]).map(i => ({
      id: row[`sub${i}_id`], name: row[`sub${i}_name`] ?? "",
      from: row[`sub${i}_from`] || null, to: row[`sub${i}_to`] || null,
    })),
  };
}

async function sheetLeave(): Promise<LeaveEntry[]> {
  const response = await fetch(sheetCsvUrl(SHEET_GID.nghi_phep), { cache: "no-store" });
  if (!response.ok) throw new Error(`Sheet leave read failed: ${response.status}`);
  const [head, ...rows] = parseLeaveCsv(await response.text());
  for (const name of SHEET_CONTRACT.nghi_phep.require) if (!head?.includes(name)) throw new Error(`Sheet leave missing ${name}`);
  const entries = rows.map(cells => leaveFromRow(Object.fromEntries(head.map((name, i) => [name, cells[i] ?? ""]))));
  if (entries.length < 100) throw new Error("Sheet leave read returned too few rows");
  return entries.filter(entry => entry.driver_id && entry.leave_from);
}

function leaveKey(entry: ReturnType<typeof leaveEntriesOnDate>[number]) {
  return JSON.stringify([entry.driver_id, entry.loai_nghi, entry.leave_from, entry.timeLabel,
    entry.subs.map(sub => [sub.id, sub.from, sub.to])]);
}

export function shadowDecision(config: Config, leaves: LeaveEntry[], job: Job) {
  const pickupId = getCustomerIdFromJob(job);
  const dropoffId = job.stops?.find(stop => stop.stop_type_id === 2)?.customer_id ?? null;
  const window = job.stops?.find(stop => stop.stop_type_id === 1)?.delivery_windows?.[0]?.time_from;
  const scheduledDate = job.scheduled_delivery_ts?.slice(0, 10) || vnDate();
  const parsed = window ? parsePickupWindowTime(window, scheduledDate) : null;
  const jobTime = parsed && Number.isFinite(parsed.getTime()) ? parsed : parseVnTimestamp(job.scheduled_delivery_ts || job.create_ts);
  const time = Number.isFinite(jobTime.getTime()) ? jobTime : new Date();
  if (!pickupId) return { mode: "none", status: "no_pickup", driverIds: [] as string[], alternateDropoffId: "" };
  const smart = findSmartMapping(config, pickupId, time, dropoffId);
  if (smart) {
    const leave = smart.smart_driver_id.map(id => {
      const state = isDriverOnLeave(id, leaves);
      if (!state.onLeave) return [id, "working"];
      const sub = resolveSubstitute(state.entry!);
      return [id, sub.status === "ok" ? sub.subId : sub.status];
    });
    const chosen = smart.smart_driver_id.length === 1
      ? resolveFixedDriver(config, pickupId, time, leaves, dropoffId, { previewOnly: true })?.driverId ?? null
      : null;
    return { mode: smart.smart_driver_id.length === 1 ? "smart(1)" : "smart", status: chosen ?? "pool",
      driverIds: smart.smart_driver_id, leave, alternateDropoffId: smart.alt_drop_off_id };
  }
  const [rows, status] = getDriversOnDuty(config, pickupId, time, dropoffId);
  const chosen = resolveFixedDriver(config, pickupId, time, leaves, dropoffId, { previewOnly: true });
  return { mode: "fixed", status: chosen?.driverId ?? status, driverIds: rows.map(row => row.driver_id),
    alternateDropoffId: rows.length === 1 ? rows[0].alt_drop_off_id : "" };
}

export async function shadowSnapshot() {
  const date = vnDate(), sunday = vnIsSunday();
  const tab = sunday ? "sunday" : "mapping";
  const [sheetRows, masterRows, sheetLeaves, dbLeaves, jobs, productionLog] = await Promise.all([
    fetchSheetRows(SHEET_GID[tab], SHEET_CONTRACT[tab]),
    sunday ? fetchSheetRows(SHEET_GID.sunday, SHEET_CONTRACT.sunday) : masterRuleRows("weekday"),
    sheetLeave(), masterLeaveRows(), getJobsByDate(date), getRunLog(100),
  ]);
  if (sheetRows.length < 100 || masterRows.length < 100) throw new Error("Rule source returned too few rows");
  const sheetMappings = dutyRows(sheetRows), masterMappings = dutyRows(masterRows);
  const masterLeaves = dbLeaves.map(row => leaveFromRow(leaveLegacyRow(row))).filter(entry => entry.driver_id && entry.leave_from);
  const leaveCounts = new Map<string, number>();
  for (const key of leaveEntriesOnDate(date, sheetLeaves).map(leaveKey)) leaveCounts.set(key, (leaveCounts.get(key) ?? 0) + 1);
  for (const key of leaveEntriesOnDate(date, masterLeaves).map(leaveKey)) leaveCounts.set(key, (leaveCounts.get(key) ?? 0) - 1);
  const ruleDifferences: number[] = [];
  for (let i = 0; i < Math.max(sheetRows.length, masterRows.length); i++) {
    if (effectiveRuleKey(dutyRows([sheetRows[i] ?? {}])[0]) !== effectiveRuleKey(dutyRows([masterRows[i] ?? {}])[0])) ruleDifferences.push(i + 2);
  }
  const sheetConfig = asConfig(sheetMappings), masterConfig = asConfig(masterMappings);
  const recentIds = new Set(productionLog.slice(-100).flatMap(line => {
    const match = line.msg.match(/\bJob\s+#?(\d+)\b/i);
    return match ? [Number(match[1])] : [];
  }));
  const candidates = jobs.filter(job => recentIds.has(job.job_id) || (job.job_status_id === 2 && !job.delivery_driver_id))
    .sort((a, b) => (b.create_ts ?? "").localeCompare(a.create_ts ?? "")).slice(0, 40);
  const comparisons = candidates.map(job => {
    const sheet = shadowDecision(sheetConfig, sheetLeaves, job), supabase = shadowDecision(masterConfig, masterLeaves, job);
    return { jobId: job.job_id, route: `${job.stops?.find(stop => stop.stop_type_id === 1)?.customer_name ?? "—"} → ${job.stops?.find(stop => stop.stop_type_id === 2)?.customer_name ?? "—"}`,
      actualDriverId: job.delivery_driver_id ?? null, sheet, supabase, match: JSON.stringify(sheet) === JSON.stringify(supabase) };
  });
  return { sampledAt: new Date().toISOString(), source: sunday ? "Sunday: Sheet on both sides" : "Weekday: Sheet vs Supabase",
    sheetRules: sheetMappings.length, supabaseRules: masterMappings.length,
    ruleDifferenceCount: ruleDifferences.length, ruleDifferenceRows: ruleDifferences.slice(0, 30),
    leaveDifferenceCount: [...leaveCounts.values()].reduce((total, count) => total + Math.abs(count), 0),
    comparisons, productionLog: productionLog.slice(-40), assignmentsPerformed: 0 };
}
