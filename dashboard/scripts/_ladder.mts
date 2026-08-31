import { config as _d } from "dotenv"; _d({ path: ".env.local" });
import { getTimelineRoutes } from "../src/lib/cartrack";
import { vnDate } from "../src/lib/time";

const date = process.argv[2] ?? vnDate(new Date());
const routes = (await getTimelineRoutes(date, "prod")) ?? [];
const stopsOf = (r: any) => (r.orderedStops ?? []);

// Attendance stops must not read as visits (a chấm-công tap is not an arrival).
const isChamCong = (s: any) =>
  (s.jobLabels ?? []).some((l: any) => /chấm công|cham cong/i.test(typeof l === "string" ? l : (l?.label ?? "")));

type Row = { name: string; jobs: Set<number>; visits: number; drivers: Set<string> };
const per = new Map<string, Row>();

for (const r of routes) {
  const s = stopsOf(r).filter((x: any) => !isChamCong(x));
  // visits = unbroken runs at one place, in route order
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1].customerId === s[i].customerId) j++;
    const cid = s[i].customerId;
    const e = per.get(cid) ?? { name: s[i].customerName, jobs: new Set<number>(), visits: 0, drivers: new Set<string>() };
    e.visits++;
    e.drivers.add(r.routeId);
    for (const st of s.slice(i, j + 1)) e.jobs.add(st.jobId);
    per.set(cid, e);
    i = j + 1;
  }
}

const rows = [...per.values()].sort((a, b) => b.jobs.size - a.jobs.size);
console.log("Cards a PSC must read today, at each grouping:\n");
console.log("  jobs  visits  drivers   worst-driver   name");
let tj = 0, tv = 0, td = 0;
for (const r of rows.slice(0, 15)) {
  // how many visits does the single busiest driver make to this place?
  let worst = 0;
  for (const rt of routes) {
    const s = stopsOf(rt).filter((x: any) => !isChamCong(x));
    let n = 0, i = 0;
    while (i < s.length) {
      let j = i;
      while (j + 1 < s.length && s[j + 1].customerId === s[i].customerId) j++;
      if (per.get(s[i].customerId)?.name === r.name) n++;
      i = j + 1;
    }
    if (n > worst) worst = n;
  }
  console.log(`  ${String(r.jobs.size).padStart(4)}  ${String(r.visits).padStart(6)}  ${String(r.drivers.size).padStart(7)}   ${String(worst).padStart(12)}   ${r.name}`);
}
for (const r of rows) { tj += r.jobs.size; tv += r.visits; td += r.drivers.size; }
console.log(`\nNetwork total: ${tj} jobs -> ${tv} visits -> ${td} driver-cards`);
console.log(`  jobs->visits  ${((1 - tv / tj) * 100).toFixed(0)}% fewer`);
console.log(`  visits->drivers ${((1 - td / tv) * 100).toFixed(0)}% fewer`);
console.log(`  jobs->drivers ${((1 - td / tj) * 100).toFixed(0)}% fewer`);

// Distribution of driver-cards per branch: is the top of the feed readable?
const dc = rows.map((r) => r.drivers.size).sort((a, b) => a - b);
const q = (p: number) => dc[Math.floor((dc.length - 1) * p)];
console.log(`\nDriver-cards per branch: p50 ${q(0.5)}  p90 ${q(0.9)}  max ${dc.at(-1)}  (${rows.length} branches)`);
const visitsPer = rows.map((r) => r.visits).sort((a, b) => a - b);
const q2 = (p: number) => visitsPer[Math.floor((visitsPer.length - 1) * p)];
console.log(`Visit-cards per branch : p50 ${q2(0.5)}  p90 ${q2(0.9)}  max ${visitsPer.at(-1)}`);
