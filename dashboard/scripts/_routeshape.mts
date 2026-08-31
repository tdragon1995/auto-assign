import { config as _d } from "dotenv"; _d({ path: ".env.local" });
import { getTimelineRoutes } from "../src/lib/cartrack";
import { vnDate } from "../src/lib/time";

const date = process.argv[2] ?? vnDate(new Date());
const routes = (await getTimelineRoutes(date, "prod")) ?? [];
console.log(`${date}: ${routes.length} routes\n`);

const stopsOf = (r: any) => (r.orderedStops ?? []);

// 1. Route length distribution
const lens = routes.map(stopsOf).map((s: any[]) => s.length).sort((a, b) => a - b);
const pct = (p: number) => lens[Math.floor((lens.length - 1) * p)];
console.log(`Stops per route: min ${lens[0]}  p50 ${pct(0.5)}  p90 ${pct(0.9)}  max ${lens.at(-1)}  total ${lens.reduce((a, b) => a + b, 0)}`);

// 2. Consecutive same-customer runs = the merge opportunity
let runs = 0, merged = 0, biggest = 0, biggestWho = "";
for (const r of routes) {
  const s = stopsOf(r);
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1].customerId === s[i].customerId) j++;
    const n = j - i + 1;
    if (n > 1) { runs++; merged += n - 1; if (n > biggest) { biggest = n; biggestWho = s[i].customerName; } }
    i = j + 1;
  }
}
const total = lens.reduce((a, b) => a + b, 0);
console.log(`Consecutive same-place runs: ${runs} runs absorbing ${merged} stops (${(merged / total * 100).toFixed(1)}% of all stops would collapse)`);
console.log(`Biggest single run: ${biggest} stops at ${biggestWho}\n`);

// 3. Per-branch view: how many routes touch a branch, and how big are they
const byCust = new Map<string, { name: string; routes: Set<string>; ownStops: number; exposed: number }>();
for (const r of routes) {
  const s = stopsOf(r);
  const seen = new Set<string>();
  for (const st of s) {
    const e = byCust.get(st.customerId) ?? { name: st.customerName, routes: new Set(), ownStops: 0, exposed: 0 };
    e.routes.add(r.routeId); e.ownStops++;
    byCust.set(st.customerId, e);
    seen.add(st.customerId);
  }
  // every customer on this route would see the whole route
  for (const c of seen) { const e = byCust.get(c)!; e.exposed += s.length; }
}
const rows = [...byCust.values()].sort((a, b) => b.exposed - a.exposed).slice(0, 12);
console.log("Top branches by how much route detail a driver-level view would ship them:");
console.log("  own  routes  stops-visible  name");
for (const r of rows) {
  console.log(`  ${String(r.ownStops).padStart(3)}  ${String(r.routes.size).padStart(6)}  ${String(r.exposed).padStart(13)}  ${r.name}`);
}

// 4. How many DISTINCT other places would a branch see
console.log("\nDistinct other locations a branch would see on its drivers' routes:");
for (const [cid, e] of [...byCust.entries()].sort((a, b) => b[1].exposed - a[1].exposed).slice(0, 8)) {
  const others = new Set<string>();
  for (const r of routes) {
    const s = stopsOf(r);
    if (!s.some((x: any) => x.customerId === cid)) continue;
    for (const x of s) if (x.customerId !== cid) others.add(x.customerName);
  }
  console.log(`  ${String(others.size).padStart(3)} others  ${e.name}`);
}
