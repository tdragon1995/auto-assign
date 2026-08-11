/**
 * Where does the assign cycle's ACTIVE CPU actually go?
 *
 * Wall-clock phase timings cannot answer this. Vercel Fluid bills execution, not elapsed
 * time, so the cycle's biggest wall-clock phases (Cartrack round-trips) are close to free
 * while a JSON.parse nobody notices is not. This measures the same clock Vercel bills —
 * process.cpuUsage() — around each CPU-bound step, using a real day's payload.
 *
 * Read-only: it fetches today's timeline and unrouted pool and transforms them in memory.
 * It creates nothing, assigns nothing, and touches neither Redis nor Vercel.
 *
 *   cd dashboard && npx tsx scripts/cpu-profile.mts
 */

import { readFileSync } from "node:fs";

// .env.local by hand — tsx does not load it, and these transforms need a real payload.
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
// Redis must stay unconfigured: assembleSnapshot is pure, but nothing here should be able
// to reach the production day snapshot even by accident.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const { getTimelineRoutes, getUnroutedJobs, timelineRoutesToJobs } = await import("../src/lib/cartrack");
const { assembleSnapshot } = await import("../src/lib/day-snapshot");

/** CPU milliseconds consumed by fn, plus wall, averaged over `runs`. */
function measure<T>(label: string, runs: number, fn: () => T): { label: string; cpu: number; wall: number; out: T } {
  const c0 = process.cpuUsage();
  const w0 = Date.now();
  let out!: T;
  for (let i = 0; i < runs; i++) out = fn();
  const c = process.cpuUsage(c0);
  return { label, cpu: (c.user + c.system) / 1000 / runs, wall: (Date.now() - w0) / runs, out };
}

const DATE = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()).slice(0, 10);
console.log(`\nProfiling a real day: ${DATE}\n`);

// ── Fetch (I/O + the JSON.parse inside jsonRpc) ────────────────────────────────
// FIRST fetch pays the fleetweb login (TLS + auth handshake) as well as the parse. The
// cron only pays that on a cold instance, so measure a SECOND fetch too — with the cookie
// cached, what is left is the steady-state cost the cycle actually repeats 340×/day.
const cFetch = process.cpuUsage();
const wFetch = Date.now();
await Promise.all([getTimelineRoutes(DATE, "prod"), getUnroutedJobs(DATE, "prod")]);
const coldCpu = (() => { const c = process.cpuUsage(cFetch); return (c.user + c.system) / 1000; })();
const coldWall = Date.now() - wFetch;

const cFetch2 = process.cpuUsage();
const wFetch2 = Date.now();
const [routes, unrouted] = await Promise.all([getTimelineRoutes(DATE, "prod"), getUnroutedJobs(DATE, "prod")]);
const fetchCpu = (() => { const c = process.cpuUsage(cFetch2); return (c.user + c.system) / 1000; })();
const fetchWall = Date.now() - wFetch2;
console.log(`cold fetch (incl. fleetweb login): ${coldCpu.toFixed(1)}ms cpu / ${coldWall}ms wall`);
console.log(`warm fetch (cookie cached):        ${fetchCpu.toFixed(1)}ms cpu / ${fetchWall}ms wall`);

if (!routes) {
  console.error("timeline fetch failed — check CARTRACK_WEB_PASS in .env.local");
  process.exitCode = 1;
} else {
  const stops = routes.reduce((n, r) => n + (r.orderedStops?.length ?? 0), 0);
  console.log(`payload: ${routes.length} routes / ${stops} stops / ${unrouted?.length ?? 0} unrouted jobs\n`);

  const RUNS = 20; // average out GC and JIT noise
  const toJobs = measure("timelineRoutesToJobs", RUNS, () => timelineRoutesToJobs(routes));
  const jobs = toJobs.out;
  const assemble = measure("assembleSnapshot (+buildPairs)", RUNS, () => assembleSnapshot(jobs, unrouted, Date.now()));
  const snap = assemble.out;
  const serialize = measure("JSON.stringify (the Redis write)", RUNS, () => {
    const fields: Record<string, string> = {};
    for (const [id, j] of snap.jobs) fields[`j:${id}`] = JSON.stringify(j);
    return JSON.stringify(snap.byLocation).length + JSON.stringify(snap.pairs).length + Object.keys(fields).length;
  });

  const rows = [
    { label: "fetch: 2 RPCs incl. JSON.parse", cpu: fetchCpu, wall: fetchWall, note: "unavoidable; parse is the CPU part" },
    { ...toJobs, note: "every cycle" },
    { ...assemble, note: "every cycle — the publish" },
    { ...serialize, note: "every cycle — the publish" },
  ];

  console.log("step                                    cpu ms    wall ms   note");
  console.log("─".repeat(88));
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(38)} ${r.cpu.toFixed(1).padStart(7)} ${r.wall.toFixed(0).padStart(10)}   ${r.note}`,
    );
  }
  const publishCpu = assemble.cpu + serialize.cpu;
  const totalCpu = rows.reduce((n, r) => n + r.cpu, 0);
  console.log("─".repeat(88));
  console.log(`${"MEASURED CPU-BOUND WORK".padEnd(38)} ${totalCpu.toFixed(1).padStart(7)}`);
  console.log(`\n  of which the snapshot publish: ${publishCpu.toFixed(1)}ms  (estimated at ~110ms when written)`);
  console.log(`  cost of publishing every cycle: ${(publishCpu * 340 / 1000).toFixed(0)}s/day  = ${(publishCpu * 340 * 30 / 3_600_000).toFixed(2)} h/month of a 4h budget`);
  console.log(`  ${(totalCpu * 340 / 1000).toFixed(0)}s/day for the measured steps alone\n`);
}
