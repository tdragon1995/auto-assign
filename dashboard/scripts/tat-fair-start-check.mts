/**
 * What the fair-start rule actually does to real days, before any of them are
 * rewritten.
 *
 * The unit tests pin the rule; this measures the blast radius. Re-archiving fifty
 * days is not reversible in any practical sense — the old rows are replaced — so
 * the size and direction of the change is worth knowing while it is still a
 * question rather than a fact.
 *
 * Uses haversine × 1.35 for the benchmark rather than the Goong-backed one the
 * archive uses. That is deliberate: it costs no API quota, and the comparison here
 * is old-clock vs new-clock on the SAME benchmark, so the benchmark's own accuracy
 * cancels out of the difference.
 *
 *   npx tsx scripts/tat-fair-start-check.mts [days]
 */
import fs from "node:fs";
import path from "node:path";
for (const line of fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { getTimelineRoutes } = await import("../src/lib/cartrack");
const { legsForRoute, LONG_GAP_OVER_TARGET_MINS, MINS_PER_KM } = await import("../src/lib/tat");
const { haversineKm } = await import("../src/lib/distance");
const { vnDate, addDays } = await import("../src/lib/time");

const DAYS = Math.max(1, Math.min(Number(process.argv[2] ?? 3), 14));
const DETOUR = 1.35;

let legs = 0, deducted = 0, priced = 0;
let onTimeBefore = 0, onTimeAfter = 0;
let gapsBefore = 0, gapsAfter = 0;
const idle: number[] = [];

for (let back = 1; back <= DAYS; back++) {
  const date = addDays(vnDate(), -back);
  const routes = await getTimelineRoutes(date);
  if (!routes) { console.error(`  ${date}: unavailable`); continue; }

  for (const r of routes) {
    for (const leg of legsForRoute(r, date)) {
      legs++;
      if (leg.idle_mins > 0) { deducted++; idle.push(leg.idle_mins); }
      if (leg.tat_mins == null || leg.from_lat == null || leg.to_lat == null) continue;

      const km = haversineKm(leg.from_lat, leg.from_lng!, leg.to_lat, leg.to_lng!) * DETOUR;
      const bench = Math.max(1, Math.ceil(km)) * MINS_PER_KM;
      priced++;

      // tat_mins is already the fair clock; adding the deduction back recovers what
      // the old rule would have charged.
      const raw = leg.tat_mins + leg.idle_mins;
      if (raw <= bench) onTimeBefore++;
      if (leg.tat_mins <= bench) onTimeAfter++;
      if (raw - bench > LONG_GAP_OVER_TARGET_MINS) gapsBefore++;
      if (leg.tat_mins - bench > LONG_GAP_OVER_TARGET_MINS) gapsAfter++;
    }
  }
  console.error(`  ${date}: done`);
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

console.log(`\nLegs: ${legs}   priced: ${priced}`);
console.log(`Legs with time deducted: ${deducted} (${pct(deducted, legs)}%)`);
console.log(`  median deduction: ${median(idle)} min   total: ${Math.round(idle.reduce((a, b) => a + b, 0) / 60)} h`);
console.log(`\nOn time:  ${onTimeBefore} → ${onTimeAfter}   (${pct(onTimeBefore, priced)}% → ${pct(onTimeAfter, priced)}%)`);
console.log(`Waits:    ${gapsBefore} → ${gapsAfter}   (${gapsBefore - gapsAfter} cleared)`);
