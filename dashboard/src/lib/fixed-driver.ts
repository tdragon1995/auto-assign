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

/**
 * The rows for this pickup that are ALLOWED to serve this destination.
 *
 * A row with a blank `dropoff_id` serves any destination — that is every row written
 * before the column existed, so blank keeps the old behaviour exactly. A row that
 * names a destination serves only that one, and rows naming a DIFFERENT destination
 * are dropped outright: they describe somebody else's leg.
 *
 * When the job's destination is unknown (no dropoff stop on it), only blank rows can
 * apply — there is nothing to match a destination row against, and guessing would
 * hand the trip to a driver whose route we cannot confirm.
 *
 * `anyForCustomer` separates the two ways `applicable` comes back empty: the branch
 * has no rows at all (not configured), versus it has rows but none for where this
 * job is going. Those are different problems for a supervisor, so they are reported
 * as different failures rather than both as "chưa cấu hình".
 */
export function mappingsForRoute(
  config: Config,
  customerId: string,
  dropoffId?: string | null,
): { applicable: Mapping[]; anyForCustomer: boolean } {
  const all = config.mappings.filter((m) => m.customer_id === customerId);
  const drop = dropoffId?.trim() || null;
  const applicable = all.filter((m) => {
    const want = m.dropoff_id?.trim();
    return !want || want === drop;
  });
  return { applicable, anyForCustomer: all.length > 0 };
}

/**
 * Most-specific-wins. If any row names this exact destination, ONLY those rows count.
 *
 * This is the whole reason the feature does not break the branches it is added to.
 * Two rows for one pickup whose shifts overlap is a CLASH, and the engine refuses to
 * assign a clash rather than guess — so adding "D014 → D007 is Hùng" beside the
 * existing "D014 is Nam" row would, without this, stop D014 assigning altogether.
 * The destination row is the more specific instruction, so it REPLACES the general
 * row for that destination instead of competing with it.
 *
 * Applied AFTER the shift filter, deliberately: a destination row that is off shift
 * hands the job back to the branch's general row rather than blocking it. Nobody
 * loses coverage they had before by adding a destination row.
 */
export function preferDestinationRows(
  rows: Mapping[],
  dropoffId?: string | null,
): Mapping[] {
  const drop = dropoffId?.trim() || null;
  if (!drop) return rows;
  const exact = rows.filter((m) => m.dropoff_id?.trim() === drop);
  return exact.length > 0 ? exact : rows;
}

/**
 * The on-shift smart-pool row for this pickup and destination, if there is one.
 *
 * Same most-specific-wins rule as the fixed path — a destination row overrides the
 * branch's general pool rather than racing it, which matters here because the old
 * code took the FIRST on-shift smart row it found and sheet order would have decided
 * which destination won.
 */
export function findSmartMapping(
  config: Config,
  customerId: string,
  jobTime: Date,
  dropoffId?: string | null,
): Mapping | undefined {
  const { applicable } = mappingsForRoute(config, customerId, dropoffId);
  const onShift = applicable.filter(
    (m) => m.smart_driver_id.length > 0 && isDriverOnShift(m, jobTime),
  );
  return preferDestinationRows(onShift, dropoffId)[0];
}

export function getDriversOnDuty(
  config: Config,
  customerId: string,
  jobTime: Date,
  /** Where the job is actually going. Omitted ⇒ destination-scoped rows can never
   *  match, so only blank rows are considered — the pre-column behaviour. */
  dropoffId?: string | null,
): [Mapping[], "no_mapping" | "no_dropoff_rule" | "no_driver" | "happy" | "clash"] {
  const { applicable, anyForCustomer } = mappingsForRoute(config, customerId, dropoffId);

  if (applicable.length === 0) {
    return [[], anyForCustomer ? "no_dropoff_rule" : "no_mapping"];
  }

  const onDuty = applicable.filter((m) =>
    isDriverOnShift(m, jobTime)
  );

  if (onDuty.length === 0) return [applicable, "no_driver"];

  const chosen = preferDestinationRows(onDuty, dropoffId);
  if (chosen.length === 1) return [chosen, "happy"];
  return [chosen, "clash"];
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
  /** The dropoff the job actually carries. Does two jobs:
   *   1. SELECTS the mapping — a row scoped to a destination only answers for jobs
   *      going there, and beats the branch's general row when it does (see
   *      mappingsForRoute / preferDestinationRows);
   *   2. REFUSES a row whose alt_drop_off_id sends the samples somewhere else, because
   *      whoever assigns also has to perform that redirection and this function does
   *      not touch the job. `opts.previewOnly` turns that half off. */
  dropoffId?: string | null,
  opts?: {
    /** The caller is only DISPLAYING who would take this job, not assigning it, so the
     *  alt-drop-off refusal above does not apply — there is no job to leave pointing at
     *  the wrong destination. The destination SELECTION still applies; a preview that
     *  named the wrong driver would be worse than none. */
    previewOnly?: boolean;
  },
): { driverId: string; name: string | null; subFor: string | null } | null {
  if (!customerId) return null;

  // An on-shift smart mapping owns the job before the fixed path is reached — but a pool
  // of ONE is not a ranking problem. There is nobody to rank it against, so the answer is
  // config, exactly like the fixed path, and the cycle already treats it that way (its
  // SMART(1) branch assigns straight out with the same leave-and-substitute handling).
  // Two or more still need live driver positions, which config cannot supply.
  const smart = findSmartMapping(config, customerId, jobTime, dropoffId);
  if (smart) {
    if (smart.smart_driver_id.length !== 1) return null;
    return settle(smart, smart.smart_driver_id[0], dropoffId, leaveEntries, opts);
  }

  const [drivers, status] = getDriversOnDuty(config, customerId, jobTime, dropoffId);
  if (status !== "happy") return null;

  const mapping = drivers[0];
  if (!mapping.driver_id) return null;
  return settle(mapping, mapping.driver_id, dropoffId, leaveEntries, opts);
}

/** Shared tail of both paths: refuse a redirected dropoff, follow leave to a substitute,
 *  and hand back a name only when one is actually known. */
function settle(
  mapping: Mapping,
  configuredDriverId: string,
  dropoffId: string | null | undefined,
  leaveEntries: LeaveEntry[],
  opts?: { previewOnly?: boolean },
): { driverId: string; name: string | null; subFor: string | null } | null {
  // This mapping redirects the samples elsewhere, and performing that redirection is the
  // assigner's job — the cycle rewrites the stop before it assigns. Answering here would
  // hand the trip to a driver while it still points at the wrong destination, so decline
  // and let the cycle do both halves. Only a redirect that DIFFERS matters; a job already
  // created pointing at the alt location needs no rewrite.
  const alt = mapping.alt_drop_off_id?.trim();
  if (!opts?.previewOnly && alt && dropoffId && alt !== dropoffId) return null;

  let driverId = configuredDriverId;
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

