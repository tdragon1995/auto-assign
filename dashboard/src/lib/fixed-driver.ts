import type { Config, Mapping } from "./types";
import { vnHoursMinutes } from "./time";
import { isValidDriverId } from "./config";
import { isDriverOnLeave, resolveSubstitute, type LeaveEntry } from "./leave-config";

/**
 * The fixed-path roster lookup, on its own and free of the assign cycle.
 *
 * Everything here is pure config arithmetic — mapping rows, shift windows, the
 * leave sheet — so it costs no Cartrack call and no Goong call. That is what lets
 * a caller OUTSIDE the cycle (the PSC booking page, which wants to hand the trip
 * it just created straight to its driver) reach the same answer the cycle would,
 * without running a cycle to get it.
 *
 * Lives in its own module rather than in assign.ts so the booking route doesn't
 * drag the whole engine — smart ranking, distance cache, return trips, Zalo — into
 * its bundle for a lookup that is three comparisons and a leave check.
 */

function timeToMinutes(t: { hours: number; minutes: number }): number {
  return t.hours * 60 + t.minutes;
}

export function isDriverOnShift(
  mapping: Mapping,
  jobTime: Date
): boolean {
  const { shift_start, shift_end } = mapping;
  if (!shift_start || !shift_end) return true; // no shift = always on

  const { hours, minutes } = vnHoursMinutes(jobTime);
  const jobMinutes = hours * 60 + minutes;
  const startMin = timeToMinutes(shift_start);
  const endMin = timeToMinutes(shift_end);

  // Overnight shift (e.g. 22:00 - 06:00)
  // shift_start is exclusive: outgoing driver owns the boundary minute
  if (startMin > endMin) {
    return jobMinutes > startMin || jobMinutes <= endMin;
  }
  return jobMinutes > startMin && jobMinutes <= endMin;
}

export function getDriversOnDuty(
  config: Config,
  customerId: string,
  jobTime: Date
): [Mapping[], "no_mapping" | "no_driver" | "happy" | "clash"] {
  const customerMappings = config.mappings.filter(
    (m) => m.customer_id === customerId
  );

  if (customerMappings.length === 0) return [[], "no_mapping"];

  const onDuty = customerMappings.filter((m) =>
    isDriverOnShift(m, jobTime)
  );

  if (onDuty.length === 0) return [customerMappings, "no_driver"];
  if (onDuty.length === 1) return [onDuty, "happy"];
  return [onDuty, "clash"];
}

/**
 * Who owns this pickup at this moment: shift window, then leave, then substitute.
 *
 * Returns null for every uncertain case — no mapping, nobody on duty, two drivers
 * on duty, an on-shift smart pool (those jobs are ranked live against driver
 * positions, so a roster lookup cannot answer for them), a driver on leave with no
 * usable substitute, a malformed id. Null means "don't guess": the caller should
 * leave the trip unassigned and let the engine handle it, which is exactly what
 * happens today.
 *
 * Mirrors the fixed path in the assign loop — if that changes, change this.
 */
export function resolveFixedDriver(
  config: Config,
  customerId: string | null,
  jobTime: Date,
  leaveEntries: LeaveEntry[],
): { driverId: string; name: string | null; subFor: string | null } | null {
  if (!customerId) return null;

  // An on-shift smart mapping wins the job before the fixed path is reached.
  const smart = config.mappings.some(
    (m) => m.customer_id === customerId && m.smart_driver_id.length > 0 && isDriverOnShift(m, jobTime),
  );
  if (smart) return null;

  const [drivers, status] = getDriversOnDuty(config, customerId, jobTime);
  if (status !== "happy") return null;

  const mapping = drivers[0];
  let driverId = mapping.driver_id;
  if (!driverId) return null;
  let name: string | null = mapping.first_name_last_name?.trim() || null;
  let subFor: string | null = null;

  const lc = isDriverOnLeave(driverId, leaveEntries);
  if (lc.onLeave) {
    const sub = resolveSubstitute(lc.entry!);
    if (sub.status !== "ok") return null;
    subFor = lc.driverName ?? null;
    driverId = sub.subId;
    // The leave row names its substitutes, and that string comes from the Driver
    // tab (the sheet resolves sub ids by name lookup), so it's a real name.
    name = lc.entry!.subs.find((s) => s.id === sub.subId)?.name?.trim() || null;
  }

  if (!isValidDriverId(driverId)) return null;
  return { driverId, name, subFor };
}
