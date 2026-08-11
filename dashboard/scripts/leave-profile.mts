/**
 * What does /api/leave-status actually spend CPU on?
 *
 * The route is cached in two tiers (per-process, then Redis at 5 min), so the question is
 * which path the invocations are taking and what each costs. Leave changes a handful of
 * times a day, so anything expensive happening more often than that is waste.
 *
 * Read-only: fetches the Leave Status sheet and parses it. Redis is left unconfigured so
 * the L2 tier is skipped and the sheet path is measured directly.
 *
 *   cd dashboard && npx tsx scripts/leave-profile.mts
 */

import { readFileSync } from "node:fs";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
// No Redis: force every call down the sheet path so it can be timed in isolation.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const { loadLeaveEntries, leaveEntriesOnDate } = await import("../src/lib/leave-config");
const { sheetCsvUrl, SHEET_GID } = await import("../src/lib/sheets");
const { vnDate, addDays } = await import("../src/lib/time");

function cpuMs(from: NodeJS.CpuUsage): number {
  const c = process.cpuUsage(from);
  return (c.user + c.system) / 1000;
}

// ── 1. Raw download, so parse cost can be separated from transfer ──────────────
const url = `${sheetCsvUrl(SHEET_GID.nghi_phep)}&_cb=${Date.now()}`;
const c0 = process.cpuUsage();
const w0 = Date.now();
const text = await (await fetch(url, { cache: "no-store" })).text();
const fetchCpu = cpuMs(c0);
const fetchWall = Date.now() - w0;

console.log(`\nLeave Status sheet: ${(text.length / 1024).toFixed(1)} KB, ${text.split("\n").length} lines`);
console.log(`  download: ${fetchCpu.toFixed(1)}ms cpu / ${fetchWall}ms wall\n`);

// ── 2. Full cold load: parse + build entries (what an L2 miss costs) ───────────
const c1 = process.cpuUsage();
const w1 = Date.now();
const entries = await loadLeaveEntries(true);
const loadCpu = cpuMs(c1);
const loadWall = Date.now() - w1;

// ── 3. Warm L1 hit, for contrast ──────────────────────────────────────────────
const c2 = process.cpuUsage();
await loadLeaveEntries(false);
const warmCpu = cpuMs(c2);

// ── 4. What the route actually returns ────────────────────────────────────────
const today = vnDate();
const c3 = process.cpuUsage();
const todayList = leaveEntriesOnDate(today, entries);
const tomorrowList = leaveEntriesOnDate(addDays(today, 1), entries);
const filterCpu = cpuMs(c3);

console.log(`entries parsed: ${entries.length}`);
console.log(`on leave today: ${todayList.length}, tomorrow: ${tomorrowList.length}`);
console.log(`payload the route returns: ${(JSON.stringify({ today: todayList, tomorrow: tomorrowList }).length / 1024).toFixed(1)} KB\n`);

// ── 5. What the Redis (L2) tier actually moves and costs ──────────────────────
// The L2 hit is the COMMON path, so its cost decides whether the TTL matters at all.
// It caches every entry, not the answer — so measure both the payload and the parse.
const blob = JSON.stringify(entries);
const c4 = process.cpuUsage();
for (let i = 0; i < 20; i++) JSON.parse(blob);
const parseCpu = cpuMs(c4) / 20;
const answerBlob = JSON.stringify({ today: todayList, tomorrow: tomorrowList });
const c5 = process.cpuUsage();
for (let i = 0; i < 20; i++) JSON.parse(answerBlob);
const answerParseCpu = cpuMs(c5) / 20;

console.log(`L2 caches ALL entries:  ${(blob.length / 1024).toFixed(1)} KB → ${parseCpu.toFixed(2)}ms cpu to parse`);
console.log(`the answer alone would be: ${(answerBlob.length / 1024).toFixed(1)} KB → ${answerParseCpu.toFixed(2)}ms cpu\n`);

console.log("path                                   cpu ms");
console.log("─".repeat(52));
console.log(`${"cold: fetch + parse + build".padEnd(38)} ${loadCpu.toFixed(1).padStart(7)}   (${loadWall}ms wall)`);
console.log(`${"warm: per-process cache hit".padEnd(38)} ${warmCpu.toFixed(1).padStart(7)}`);
console.log(`${"filter to today + tomorrow".padEnd(38)} ${filterCpu.toFixed(1).padStart(7)}`);
console.log("─".repeat(52));

// The assign cycle calls loadLeaveEntries twice per run, ~340 runs/day.
console.log(`\nif every call went cold: ${(loadCpu * 340 * 2 / 1000).toFixed(0)}s/day just for the cron`);
console.log(`at the current 5-min Redis TTL, ~${Math.round(17 * 60 / 5)} cold loads/day = ${(loadCpu * 17 * 60 / 5 / 1000).toFixed(1)}s/day`);
