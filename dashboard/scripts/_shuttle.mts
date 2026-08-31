import { config as _d } from "dotenv"; _d({ path: ".env.local" });
import { getTimelineRoutes } from "../src/lib/cartrack";
import { vnDate } from "../src/lib/time";

const date = process.argv[2] ?? vnDate(new Date());
const routes = (await getTimelineRoutes(date, "prod")) ?? [];
const stopsOf = (r: any) => (r.orderedStops ?? []);

// Find the route with the most stops at D001 and print its actual shape.
let best: any = null, bestN = 0;
for (const r of routes) {
  const n = stopsOf(r).filter((s: any) => (s.customerName ?? "").includes("D001")).length;
  if (n > bestN) { bestN = n; best = r; }
}
console.log(`Heaviest D001 route: ${best.routeId} — ${bestN} D001 stops of ${stopsOf(best).length} total\n`);
const sym = (s: any) => (s.stopTypeId === 1 ? "PICK" : "DROP");
for (const [i, s] of stopsOf(best).entries()) {
  const at = (s.activityCompletedTs ?? s.activityArrivedTs ?? "").slice(11, 16) || "  -  ";
  const mark = (s.customerName ?? "").includes("D001") ? " <<<" : "";
  console.log(`  ${String(i + 1).padStart(2)}. ${at} ${sym(s)} ${(s.customerName ?? "").slice(0, 46)}${mark}`);
}

// Across ALL routes: are same-place stops consecutive (batch) or interleaved (shuttle)?
let batchRuns = 0, batchStops = 0, shuttleRevisits = 0;
for (const r of routes) {
  const s = stopsOf(r);
  const runs = new Map<string, number[]>();
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1].customerId === s[i].customerId) j++;
    const n = j - i + 1;
    if (n > 1) { batchRuns++; batchStops += n; }
    runs.set(s[i].customerId, [...(runs.get(s[i].customerId) ?? []), n]);
    i = j + 1;
  }
  for (const [, v] of runs) if (v.length > 1) shuttleRevisits += v.length - 1;
}
console.log(`\nNetwork: ${batchRuns} batched runs (${batchStops} stops sitting together) vs ${shuttleRevisits} shuttle revisits (same place, later)`);
