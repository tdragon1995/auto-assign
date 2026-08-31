/* read-only: rebuild one driver's route state as of a given clock time from the
   activity timestamps, then run the anchor rule against it. */
import { config } from "dotenv";
config({ path: ".env.local" });
const { getTimelineRoutes, getDrivers } = await import("../src/lib/cartrack");
const { selectReferenceStop, isUnreachedAnchor, liveGpsRef, lastRealPositionRef } = await import("../src/lib/smart-rank");
const { haversineKm } = await import("../src/lib/distance");
const { vnDate } = await import("../src/lib/time");

const CUT = process.argv[2] ?? "06:33";
const NEEDLE = process.argv[3] ?? "DC101616";
const date = vnDate();
const hhmm = (ts: string | null) => (ts ? (/[ T](\d{2}:\d{2})/.exec(ts)?.[1] ?? "") : "");
const before = (ts: string | null) => !!ts && hhmm(ts) <= CUT;

const [routes, drivers] = await Promise.all([getTimelineRoutes(date, "prod"), getDrivers("prod")]);
const d: any = drivers.find((x: any) => `${x.first_name} ${x.last_name}`.includes(NEEDLE));
if (!d) { console.log("driver not found"); process.exit(1); }
const route: any = (routes ?? []).find((r: any) => r.routeId === `driver_${d.delivery_driver_id}`);
if (!route) { console.log("no route today"); process.exit(1); }

console.log(`${d.first_name} ${d.last_name}  —  route as it stood at ${CUT}\n`);
const asOf: any[] = [];
for (const s of route.orderedStops ?? []) {
  const status = before(s.activityCompletedTs) ? 4
    : before(s.activityArrivedTs) ? 3
    : before(s.activityStartedTs) ? 2
    : 1;
  const touchedLater = !!(s.activityCompletedTs || s.activityArrivedTs || s.activityStartedTs) && status === 1;
  asOf.push({ ...s, stopStatusId: status });
  console.log(
    `  job ${s.jobId}  ${s.stopTypeId === 1 ? "pickup " : "dropoff"}  ${["", "pending", "en route", "arrived", "done"][status]}`.padEnd(46) +
    `${(s.customerName ?? "").slice(0, 34).padEnd(36)}` +
    `${status === 4 ? `done ${hhmm(s.activityCompletedTs)}` : touchedLater ? `(worked later at ${hhmm(s.activityCompletedTs) || hhmm(s.activityArrivedTs) || hhmm(s.activityStartedTs)})` : ""}`
  );
}

const ref: any = selectReferenceStop(asOf as any, null);
console.log(`\nAnchor at ${CUT}: ${ref ? `${ref.label} @${ref.customerName}` : "none"}`);
console.log(`  planned + untouched? ${ref?.plannedUnstarted === true ? "YES — re-anchored" : "no — kept as a real position"}`);
if (ref?.altLat != null) console.log(`  last completed stop carried as alt point`);
const gps = d.latitude != null ? liveGpsRef(ref, d.latitude, d.longitude, null) : null;
const demoted = ref && !gps ? lastRealPositionRef(ref) : null;
const used = isUnreachedAnchor(ref) ? (gps ?? demoted ?? ref) : ref;
console.log(`  → ranked from: ${used?.customerName ?? "—"} (${used?.lat}, ${used?.lon})`);

// distance from every candidate anchor point to the pickup
const PICKUP = process.argv[4];
if (PICKUP) {
  const [plat, plon] = PICKUP.split(",").map(Number);
  const km = (la: number, lo: number) => Math.round(haversineKm(la, lo, plat, plon) * 10) / 10;
  if (ref) console.log(`\n  straight-line to pickup — planned anchor ${km(ref.lat, ref.lon)} km` +
    (ref.altLat != null ? `, last completed ${km(ref.altLat, ref.altLon)} km` : "") +
    (gps ? `, live GPS (now) ${km(gps.lat, gps.lon)} km` : ""));
}
