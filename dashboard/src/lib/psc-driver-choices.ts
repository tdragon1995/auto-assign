import { getLiveDrivers, type Env, type LiveDriver } from "./cartrack";
import { loadConfigFromSheets } from "./config";
import { loadLeaveEntries, type LeaveEntry } from "./leave-config";
import { resolveDriverChoices } from "./fixed-driver";
import { driverDisplayName } from "./display-names";
import type { Config } from "./types";

/** One row of the branch's driver picker. The name is the personal name only — no
 *  staff code, no PT/FT prefix. */
export type PickerDriver = { driver_id: string; name: string };

export type PickerResult = { drivers: PickerDriver[]; reason: string | null };

type Inputs = [Config | null, LeaveEntry[] | null, LiveDriver[] | null];

/** Roster, leave and the live driver list. Independent of the trip, so callers start
 *  this BEFORE anything else they must fetch rather than queueing behind it. */
export function loadChoiceInputs(env: Env): Promise<Inputs> {
  return Promise.all([
    loadConfigFromSheets({ requireCurrentDay: true }).catch(() => null),
    loadLeaveEntries().catch(() => null),
    getLiveDrivers(env).catch(() => null),
  ]);
}

/**
 * The drivers a branch may pick for a trip on this route, each confirmed against the
 * live list of ACTIVE accounts. A driver missing from that list is left out — a trip on
 * a deactivated account looks healthy and nobody comes. When the list itself cannot be
 * read nothing is offered rather than something unverified.
 */
export function driverChoices(
  [config, leave, live]: Inputs,
  pickup: string,
  dropoff: string,
  requestedAt: Date,
  exclude?: string | null,
): PickerResult {
  const empty = (reason: string): PickerResult => ({ drivers: [], reason });
  if (!config) return empty("roster_unavailable");
  if (!leave) return empty("leave_unavailable");
  if (!live) return empty("drivers_unavailable");

  const res = resolveDriverChoices(config, pickup, dropoff, leave, requestedAt);
  if (!res.ok) return empty(res.reason);

  const byId = new Map(live.map((d) => [d.deliveryDriverId, d]));
  const drivers: PickerDriver[] = [];
  for (const c of res.drivers) {
    const d = byId.get(c.driverId);
    if (!d || c.driverId === exclude) continue;
    const name = driverDisplayName(`${d.firstName ?? ""} ${d.lastName ?? ""}`) || driverDisplayName(c.name);
    // Names carry no staff code, so a person's PT and DC accounts would read as the same
    // line twice. Offer the first; either account reaches the same person.
    if (!name || drivers.some((x) => x.name === name)) continue;
    drivers.push({ driver_id: c.driverId, name });
  }
  return { drivers, reason: drivers.length ? null : "no_driver" };
}
