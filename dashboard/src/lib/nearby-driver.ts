import { haversineKm } from "./distance";
import { PSC_ROUTES } from "./psc-routes-data";
import { PROXY_DRIVER_ID } from "./cartrack";

/**
 * "Somebody is standing right there" — pick the driver physically at a PSC when a
 * branch books a pickup, in preference to the one the roster names.
 *
 * The roster answer is who OUGHT to collect; this is who can collect in the next
 * minute, and when the two disagree the second one wins. A driver already in the
 * building carries the samples out on the trip they are on.
 */

/** How close counts as "here". Straight line, not road — at this range the two are
 *  the same number, and a road lookup would cost a request per booking. */
export const NEARBY_RADIUS_M = 100;

/**
 * A position is only evidence of where somebody IS while it is recent. Measured on
 * the live fleet 2026-08-18: of 95 drivers carrying coordinates, 43 had last been
 * seen more than six hours earlier — those are last night's parking spots, and half
 * of them sit inside a PSC. Without this bound the feature would hand trips to
 * people who went home. 15 minutes keeps every driver who is actually working (26
 * of 95 at the time of measurement) and discards the ghosts.
 */
export const GPS_MAX_AGE_MIN = 15;

/** The few fields the choice actually turns on, named as the fleetweb list returns
 *  them. Deliberately not the full driver shape: this module has no business
 *  knowing about shifts, stats or containers. */
export type NearbyCandidate = {
  deliveryDriverId: string;
  firstName?: string | null;
  lastName?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  isLoggedIn?: boolean | null;
  lastOnlineTs?: string | null;
};

/** Cartrack timestamps arrive as "YYYY-MM-DD HH:MM:SS.ssssss+07" — a space instead
 *  of the T, and a two-digit offset Date won't parse. Returns null rather than an
 *  Invalid Date, so an unreadable stamp reads as "no idea how old this is" and the
 *  driver is skipped. */
function parseCtTs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(String(ts).replace(" ", "T").replace(/\+(\d{2})$/, "+$1:00"));
  return Number.isNaN(ms) ? null : ms;
}

/** The pickup's coordinates, from the hard-coded route table. Several routes can
 *  share one pickup (different dropoffs); they carry the same origin, so the first
 *  match is the answer. */
export function pscPickupCoords(pickupCustomerId: string): { lat: number; lon: number } | null {
  const r = PSC_ROUTES.find(
    (x) => x.pickup === pickupCustomerId && x.lat != null && x.lon != null,
  );
  return r ? { lat: r.lat as number, lon: r.lon as number } : null;
}

/**
 * Everyone within the radius of `lat`/`lon` right now, nearest first.
 *
 * Returns a list rather than one driver on purpose: the caller tries them in order,
 * because the nearest driver can still be refused (a break, a dead account) and the
 * second-nearest is standing in the same room. Nobody is asked WHY a driver was
 * refused — the attempt is the question.
 *
 * The parking proxy is excluded. It is an account we park trips on, not a person,
 * and it has no location of its own worth trusting.
 */
export function driversWithin(
  drivers: NearbyCandidate[],
  lat: number,
  lon: number,
  radiusM: number = NEARBY_RADIUS_M,
  now: number = Date.now(),
): { driverId: string; name: string; metres: number }[] {
  const out: { driverId: string; name: string; metres: number }[] = [];
  for (const d of drivers) {
    if (!d.deliveryDriverId || d.deliveryDriverId === PROXY_DRIVER_ID) continue;
    if (d.latitude == null || d.longitude == null) continue;
    // Logged out means the app is closed; whatever the last fix said, that person
    // is not about to accept a trip.
    if (d.isLoggedIn === false) continue;
    const seen = parseCtTs(d.lastOnlineTs);
    if (seen == null || now - seen > GPS_MAX_AGE_MIN * 60_000) continue;
    const metres = haversineKm(lat, lon, d.latitude, d.longitude) * 1000;
    if (metres > radiusM) continue;
    out.push({
      driverId: d.deliveryDriverId,
      name: `${d.firstName ?? ""} ${d.lastName ?? ""}`.trim() || d.deliveryDriverId,
      metres: Math.round(metres),
    });
  }
  return out.sort((a, b) => a.metres - b.metres);
}

/** Convenience for the booking route: candidates at a PSC pickup, nearest first.
 *  Empty when the pickup has no coordinates on file or nobody is there. */
export function driversAtPscPickup(
  drivers: NearbyCandidate[],
  pickupCustomerId: string,
): { driverId: string; name: string; metres: number }[] {
  const at = pscPickupCoords(pickupCustomerId);
  if (!at) return [];
  return driversWithin(drivers, at.lat, at.lon);
}
