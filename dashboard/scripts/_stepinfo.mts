import { config as _d } from "dotenv"; _d({ path: ".env.local" });
import { getTimelineRoutes } from "../src/lib/cartrack";
import { vnDate } from "../src/lib/time";

const date = process.argv[2] ?? vnDate(new Date());
const routes = (await getTimelineRoutes(date, "prod")) ?? [];
const stopsOf = (r: any) => (r.orderedStops ?? []);

// ── A. Branch-level merge: per (branch, driver), how many job-cards collapse to one?
const pair = new Map<string, { branch: string; jobs: Set<number> }>();
for (const r of routes) for (const s of stopsOf(r)) {
  const k = `${s.customerId}|${r.routeId}`;
  const e = pair.get(k) ?? { branch: s.customerName, jobs: new Set<number>() };
  e.jobs.add(s.jobId); pair.set(k, e);
}
const sizes = [...pair.values()].map((p) => p.jobs.size);
const cards = sizes.reduce((a, b) => a + b, 0);
const grouped = sizes.length;
console.log(`Branch feed today: ${cards} job-cards -> ${grouped} driver-cards (${((1 - grouped / cards) * 100).toFixed(0)}% fewer)`);
const multi = [...pair.values()].filter((p) => p.jobs.size > 1).sort((a, b) => b.jobs.size - a.jobs.size);
console.log(`Pairs holding >1 job: ${multi.length}; biggest ${multi[0]?.jobs.size ?? 0} jobs at ${multi[0]?.branch ?? "-"}`);
const hist = new Map<number, number>();
for (const s of sizes) hist.set(s, (hist.get(s) ?? 0) + 1);
console.log("jobs-per-driver-card:", [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}x${v}`).join(" "));

// D001 specifically
const d001 = [...pair.entries()].filter(([k]) => pair.get(k)!.branch.includes("D001"));
const d001cards = d001.reduce((a, [, p]) => a + p.jobs.size, 0);
console.log(`  D001 alone: ${d001cards} job-cards -> ${d001.length} driver-cards`);

// ── B. Are the step-bar timestamps informative?
// step2 "Lấy mẫu"  = pickup.completed ; step3 "Đang giao" = dropoff.started
const byJob = new Map<number, any[]>();
for (const r of routes) for (const s of stopsOf(r)) {
  byJob.set(s.jobId, [...(byJob.get(s.jobId) ?? []), s]);
}
let n = 0, dStartNull = 0, dStartDupPComplete = 0, dStartUseful = 0;
let pStartNull = 0, pStartEqPComplete = 0, pStartEarlier = 0, gapMins: number[] = [];
const t = (x: any) => (typeof x === "string" && x.length >= 19 ? x.slice(0, 19) : null);
for (const [, ss] of byJob) {
  const p = ss.find((s) => s.stopTypeId === 1);
  const d = ss.find((s) => s.stopTypeId !== 1);
  if (!p || !d) continue;
  const pc = t(p.activityCompletedTs), ds = t(d.activityStartedTs), ps = t(p.activityStartedTs);
  if (!pc) continue; // only jobs that actually reached collection
  n++;
  if (!ds) dStartNull++;
  else if (ds === pc) dStartDupPComplete++;
  else dStartUseful++;
  if (!ps) pStartNull++;
  else if (ps === pc) pStartEqPComplete++;
  else {
    pStartEarlier++;
    gapMins.push((new Date(pc.replace(" ", "T")).getTime() - new Date(ps.replace(" ", "T")).getTime()) / 60000);
  }
}
console.log(`\nCollected jobs today: ${n}`);
console.log(`step3 "Đang giao" (dropoff.started):  null ${dStartNull} (${(dStartNull / n * 100).toFixed(0)}%) | same as step2 ${dStartDupPComplete} (${(dStartDupPComplete / n * 100).toFixed(0)}%) | distinct ${dStartUseful} (${(dStartUseful / n * 100).toFixed(0)}%)`);
console.log(`pickup.started vs pickup.completed:   null ${pStartNull} (${(pStartNull / n * 100).toFixed(0)}%) | identical ${pStartEqPComplete} (${(pStartEqPComplete / n * 100).toFixed(0)}%) | genuinely earlier ${pStartEarlier} (${(pStartEarlier / n * 100).toFixed(0)}%)`);
if (gapMins.length) {
  gapMins.sort((a, b) => a - b);
  const q = (p: number) => gapMins[Math.floor((gapMins.length - 1) * p)].toFixed(0);
  console.log(`   when earlier, head-start warning = p25 ${q(0.25)}m  p50 ${q(0.5)}m  p90 ${q(0.9)}m  max ${gapMins.at(-1)!.toFixed(0)}m`);
}
