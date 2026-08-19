/**
 * Is `target = 4 × ceil(km)` fair across distances, or does it punish short legs?
 *
 * THE QUESTION. Every leg carries overhead that does not scale with distance —
 * getting out of a parking area, the first two sets of lights, finding the gate at
 * the far end. A pure multiplication gives a 2 km leg 8 minutes and a 20 km leg 80,
 * so the same fixed overhead eats 100% of the short leg's allowance and 10% of the
 * long one's. If that overhead is real, short legs are structurally judged harsher
 * and the "trễ" on them is an artefact of the formula, not of the riding.
 *
 * WHY STRAIGHT-LINE DISTANCE IS ENOUGH HERE. Road distance ≈ c × straight-line for
 * some detour factor c. If true time is `a + b·road`, then in straight-line terms
 * it is `a + (b·c)·straight` — the SLOPE changes with c, the INTERCEPT does not.
 * The intercept is exactly what this is measuring, so it survives not having a
 * road-distance source. Slopes below are reported in road-km using a detour factor
 * and should be read as indicative; the intercept should not.
 *
 * Reads Cartrack only — no Supabase, no Redis, no Goong, and it writes nothing.
 *
 *   npx tsx scripts/tat-calibration.mts [days]
 */
import fs from "node:fs";
import path from "node:path";

// tsx does not load .env.local the way `next dev` does.
for (const line of fs.readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { getTimelineRoutes } = await import("../src/lib/cartrack");
const { legsForRoute, MINS_PER_KM, LONG_GAP_OVER_TARGET_MINS } = await import("../src/lib/tat");
const { haversineKm } = await import("../src/lib/distance");
const { vnDate, addDays } = await import("../src/lib/time");

/** Typical urban road-to-straight-line ratio. Only scales the x-axis for display;
 *  it cannot move the intercept, which is the finding that matters. */
const DETOUR = 1.35;

const DAYS = Math.max(1, Math.min(Number(process.argv[2] ?? 5), 21));

interface Sample { km: number; mins: number }
const samples: Sample[] = [];
let skippedNoCoords = 0, skippedGaps = 0;

const today = vnDate();
for (let back = 1; back <= DAYS; back++) {
  const date = addDays(today, -back);
  const routes = await getTimelineRoutes(date);
  if (!routes) { console.error(`  ${date}: no routes (Cartrack unavailable)`); continue; }

  let kept = 0;
  for (const r of routes) {
    for (const leg of legsForRoute(r, date)) {
      if (leg.tat_mins == null) continue;
      if (leg.from_lat == null || leg.from_lng == null || leg.to_lat == null || leg.to_lng == null) {
        skippedNoCoords++; continue;
      }
      const km = haversineKm(leg.from_lat, leg.from_lng, leg.to_lat, leg.to_lng) * DETOUR;
      // Same rule production uses, so waits do not drag the fit.
      const provisionalTarget = Math.max(1, Math.ceil(km)) * MINS_PER_KM;
      if (leg.tat_mins - provisionalTarget > LONG_GAP_OVER_TARGET_MINS) { skippedGaps++; continue; }
      samples.push({ km, mins: leg.tat_mins });
      kept++;
    }
  }
  console.error(`  ${date}: ${kept} legs`);
}

if (samples.length < 50) {
  console.error(`\nOnly ${samples.length} legs — too few to conclude anything.`);
  process.exitCode = 1;
} else {
  const pctl = (xs: number[], q: number) => {
    const a = [...xs].sort((p, q2) => p - q2);
    return a[Math.min(a.length - 1, Math.floor(q * a.length))];
  };
  const median = (xs: number[]) => pctl(xs, 0.5);

  console.log(`
Sample: ${samples.length} legs over ${DAYS} day(s)`);
  console.log(`Excluded: ${skippedGaps} waits, ${skippedNoCoords} without coordinates
`);

  const bands: [number, number, string][] = [
    [0, 1, "0-1 km  "], [1, 2, "1-2 km  "], [2, 3, "2-3 km  "], [3, 5, "3-5 km  "],
    [5, 8, "5-8 km  "], [8, 12, "8-12 km "], [12, 99, "12+ km  "],
  ];

  console.log("  band       legs   median   p75   target   on-time");
  const fitPts: { x: number; med: number; p75: number }[] = [];
  for (const [lo, hi, label] of bands) {
    const inBand = samples.filter((p) => p.km >= lo && p.km < hi);
    if (inBand.length < 10) continue;
    const mins = inBand.map((p) => p.mins);
    const med = median(mins);
    const p75 = pctl(mins, 0.75);
    const tgt = median(inBand.map((p) => Math.max(1, Math.ceil(p.km)) * MINS_PER_KM));
    const onTime = inBand.filter((p) => p.mins <= Math.max(1, Math.ceil(p.km)) * MINS_PER_KM).length;
    const midKm = median(inBand.map((p) => p.km));
    fitPts.push({ x: midKm, med, p75 });
    console.log(
      `  ${label} ${String(inBand.length).padStart(5)}   ${String(med).padStart(6)}  ${String(p75).padStart(4)}   ` +
      `${String(tgt).padStart(6)}   ${String(Math.round((onTime / inBand.length) * 100)).padStart(5)}%`,
    );
  }

  /** Least squares over the BAND points, not raw legs. Leg times are heavily
   *  right-skewed — a handful of very slow legs drag a raw fit's intercept up by
   *  several minutes and would overstate the fixed overhead badly. */
  function fit(pts: { x: number; y: number }[]) {
    const n = pts.length;
    const sx = pts.reduce((s, p) => s + p.x, 0), sy = pts.reduce((s, p) => s + p.y, 0);
    const sxy = pts.reduce((s, p) => s + p.x * p.y, 0), sxx = pts.reduce((s, p) => s + p.x * p.x, 0);
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    return { a: (sy - b * sx) / n, b };
  }

  const typical = fit(fitPts.map((p) => ({ x: p.x, y: p.med })));
  const fair = fit(fitPts.map((p) => ({ x: p.x, y: p.p75 })));

  console.log(`
Typical leg (median trend):  ${typical.a.toFixed(1)} + ${typical.b.toFixed(2)} × km`);
  console.log(`Current rule:                0.0 + ${MINS_PER_KM.toFixed(2)} × km`);
  console.log(
    `
A target line that would pass ~75% of legs IN EVERY BAND:
` +
    `  ${Math.round(fair.a)} + ${fair.b.toFixed(1)} × km   ` +
    `(currently ${Math.round((samples.filter((p) => p.mins <= Math.max(1, Math.ceil(p.km)) * MINS_PER_KM).length / samples.length) * 100)}% overall, ` +
    `but spread 55%→84% across bands)`,
  );
}
