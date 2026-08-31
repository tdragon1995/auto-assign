import { config as _d } from "dotenv"; _d({ path: ".env.local" });
import { getTimelineRoutes } from "../src/lib/cartrack";
import { vnDate } from "../src/lib/time";

const date = process.argv[2] ?? vnDate(new Date());
const routes = (await getTimelineRoutes(date, "prod")) ?? [];
const stopsOf = (r: any) => (r.orderedStops ?? []);

// A "visit" = a maximal run of consecutive stops at the same place in route order.
// If a (driver, branch) pair has >1 visit, merging blindly by pair would fuse a
// morning collection with an evening return — two different trips, one card.
let pairs = 0, multiVisit = 0, worst = 0, worstWho = "";
const visitsPerPair: number[] = [];
for (const r of routes) {
  const s = stopsOf(r);
  const runs = new Map<string, number>();
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1].customerId === s[i].customerId) j++;
    runs.set(s[i].customerId, (runs.get(s[i].customerId) ?? 0) + 1);
    i = j + 1;
  }
  for (const [cid, v] of runs) {
    pairs++; visitsPerPair.push(v);
    if (v > 1) {
      multiVisit++;
      if (v > worst) { worst = v; worstWho = `${s.find((x: any) => x.customerId === cid)?.customerName} / ${r.routeId}`; }
    }
  }
}
console.log(`${date}: ${pairs} (driver, place) pairs`);
console.log(`  pairs visited ONCE : ${pairs - multiVisit} (${((pairs - multiVisit) / pairs * 100).toFixed(0)}%)`);
console.log(`  pairs revisited    : ${multiVisit} (${(multiVisit / pairs * 100).toFixed(0)}%)  <- blind merge would fuse separate trips`);
console.log(`  worst: ${worst} separate visits — ${worstWho}`);

// Time gap between separate visits, to show they really are different trips
const gaps: number[] = [];
const t = (x: any) => (typeof x === "string" && x.length >= 19 ? new Date(x.slice(0, 19).replace(" ", "T")).getTime() : null);
for (const r of routes) {
  const s = stopsOf(r);
  const seen = new Map<string, number[]>();
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1].customerId === s[i].customerId) j++;
    const ts = s.slice(i, j + 1).map((x: any) => t(x.activityCompletedTs) ?? t(x.activityArrivedTs)).filter(Boolean) as number[];
    if (ts.length) seen.set(s[i].customerId, [...(seen.get(s[i].customerId) ?? []), Math.min(...ts)]);
    i = j + 1;
  }
  for (const [, times] of seen) {
    if (times.length < 2) continue;
    times.sort((a, b) => a - b);
    for (let k = 1; k < times.length; k++) gaps.push((times[k] - times[k - 1]) / 60000);
  }
}
if (gaps.length) {
  gaps.sort((a, b) => a - b);
  const q = (p: number) => gaps[Math.floor((gaps.length - 1) * p)].toFixed(0);
  console.log(`\nGap between a driver's separate visits to the same place: p10 ${q(0.1)}m  p50 ${q(0.5)}m  p90 ${q(0.9)}m  max ${gaps.at(-1)!.toFixed(0)}m  (n=${gaps.length})`);
}
