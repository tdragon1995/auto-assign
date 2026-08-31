/* read-only replay: old vs new anchor for every driver on today's routes. */
import { config } from "dotenv";
config({ path: ".env.local" });
const { getTimelineRoutes, getDrivers } = await import("../src/lib/cartrack");
const { selectReferenceStop, isUnreachedAnchor, liveGpsRef, lastRealPositionRef } = await import("../src/lib/smart-rank");
const { haversineKm } = await import("../src/lib/distance");
const { vnDate } = await import("../src/lib/time");

const date = process.argv[2] ?? vnDate();
const [routes, drivers] = await Promise.all([getTimelineRoutes(date, "prod"), getDrivers("prod")]);
const byId = new Map(drivers.map((d: any) => [d.delivery_driver_id, d]));
let changed = 0, same = 0, viaGps = 0, viaPrev = 0, stuck = 0;
const rows: string[] = [];
for (const r of (routes ?? []) as any[]) {
  const id = r.routeId.replace(/^driver_/, "");
  const d: any = byId.get(id);
  const old: any = selectReferenceStop((r.orderedStops ?? []) as any, null);
  if (!old) continue;
  if (!isUnreachedAnchor(old)) { same++; continue; }
  let now: any = null;
  if (d?.latitude != null && d?.longitude != null) { now = liveGpsRef(old, d.latitude, d.longitude, null); viaGps++; }
  else { now = lastRealPositionRef(old); now ? viaPrev++ : stuck++; }
  if (!now) continue;
  changed++;
  const km = Math.round(haversineKm(old.lat, old.lon, now.lat, now.lon) * 10) / 10;
  rows.push(`${String(km).padStart(6)} km moved  ${old.label.padEnd(10)} @${String(old.customerName).slice(0, 34).padEnd(34)} → ${now.customerName}`);
}
rows.sort((a, b) => parseFloat(b) - parseFloat(a));
console.log(`date=${date} routes=${(routes ?? []).length} | anchors unchanged (real position) ${same} | re-anchored ${changed} (GPS ${viaGps}, last stop ${viaPrev}) | left as-is, nothing better known ${stuck}`);
console.log(rows.join("\n"));
