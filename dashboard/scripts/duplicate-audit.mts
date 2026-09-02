/**
 * Are there duplicate trips live right now that the guard should have blocked?
 *
 * Mirrors buildPairs in day-snapshot exactly — same predicate, same exclusions — but keeps
 * EVERY job per pickup→dropoff pair instead of only the first. A pair holding more than one
 * still-active job is a duplicate the guard let through: two drivers collecting the same
 * samples.
 *
 * Read-only. Fetches today's day the way the app does and prints. Changes nothing.
 *
 *   cd dashboard && npx tsx scripts/duplicate-audit.mts
 */

import { readFileSync } from "node:fs";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
// Never read or write the production day snapshot while auditing it.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const { buildSnapshot } = await import("../src/lib/day-snapshot");
const { isBlockingPickupStop, pscPairKey, STOP_STATUS } = await import("../src/lib/job-filters");
const { PSC_VIA_LABEL } = await import("../src/lib/job-filters");
const { vnDate } = await import("../src/lib/time");

const DATE = vnDate();
const snap = await buildSnapshot(DATE, "prod");
if (!snap) {
  console.error("Could not build the day — check CARTRACK_WEB_PASS in .env.local");
  process.exitCode = 1;
} else {
  const jobs = [...snap.jobs.values()];
  console.log(`\nDuplicate audit — ${DATE}`);
  console.log(`${jobs.length} jobs on the day\n`);

  // Same rules buildPairs applies, so this cannot disagree with the guard.
  const groups = new Map<string, typeof jobs>();
  let exemptCount = 0;
  for (const j of jobs) {
    if (j.job_status_id === 7 || j.job_status_id === 3) continue;
    if (j.labels.includes(PSC_VIA_LABEL)) { exemptCount++; continue; }
    const pickups = j.stops.filter((s) => s.stop_type_id === 1 && s.customer_id && isBlockingPickupStop(s));
    if (!pickups.length) continue;
    const dropoffs = j.stops.filter((s) => s.stop_type_id === 2 && s.customer_id);
    for (const p of pickups) for (const d of dropoffs) {
      const k = pscPairKey(p.customer_id!, d.customer_id!);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(j);
    }
  }

  // A pair covered by several PLANNED trips is normal, not a duplicate: a PSC is collected
  // repeatedly through the day and the plan schedules each slot (references read
  // "D042▶️D001_3", "_4", "_5"). Those carry last_assigned_plan_id. The guard exists to stop
  // a BRANCH booking an ad-hoc trip on top of an existing one, so only jobs with no plan
  // attached can constitute the failure being audited for.
  const adHoc = (j: (typeof jobs)[number]) => j.last_assigned_plan_id == null;
  const collisions = [...groups.entries()]
    .map(([pair, js]) => [pair, [...new Map(js.map((j) => [j.job_id, j])).values()]] as const)
    .filter(([, js]) => js.filter(adHoc).length > 1);
  const plannedGroups = [...groups.values()].filter(
    (js) => new Set(js.map((j) => j.job_id)).size > 1,
  ).length;

  console.log(`pairs with an active pickup: ${groups.size}`);
  console.log(`via-leg jobs exempt by label: ${exemptCount}`);
  console.log(`pairs with several PLANNED collections (normal): ${plannedGroups - collisions.length}`);
  console.log(`ACTIVE DUPLICATES (two ad-hoc bookings, same pair): ${collisions.length}\n`);

  for (const [pair, uniq] of collisions) {
    const name = uniq[0].stops.find((s) => s.stop_type_id === 1)?.customer_name ?? pair;
    const to = uniq[0].stops.find((s) => s.stop_type_id === 2)?.customer_name ?? "";
    console.log(`  ${name} → ${to}`);
    for (const j of uniq.filter(adHoc)) {
      const pu = j.stops.find((s) => s.stop_type_id === 1);
      const status = STOP_STATUS[pu?.stop_status_id ?? 0]?.label ?? `?${pu?.stop_status_id}`;
      console.log(`    job ${j.job_id}  ${j.reference_number ?? ""}  pickup=${status}  driver=${j.driver.last_name ?? "—"}  labels=[${j.labels.join(", ")}]`);
    }
    console.log("");
  }

  if (collisions.length === 0) {
    console.log("  none — no pair is covered by two active jobs.\n");
  }
}
