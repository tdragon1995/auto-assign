const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(file, deps) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', outputText)((id) => {
    if (id in deps) return deps[id];
    throw new Error(`Unexpected dependency: ${id}`);
  }, mod, mod.exports);
  return mod.exports;
}

test('archive, payroll and historical ETA consume one pre-rollover timeline', async () => {
  const routes = [{ routeId: 'driver_1', orderedStops: [] }];
  const readCalls = [];
  const reads = load('src/lib/morning-reads.ts', { './cartrack': {
    getTimelineRoutes: async (date, env) => { readCalls.push(`${env}:${date}`); return routes; },
  } }).createMorningReads();
  const consumers = [];
  const archive = load('src/lib/tat-archive.ts', {
    '@upstash/redis': { Redis: class {} },
    './cartrack': { getTimelineRoutes: async () => { throw new Error('standalone fetch should not run'); } },
    './pickup-setup': { pickupEtaRows: (r) => { consumers.push(['eta', r]); return []; }, writePickupEta: async () => 0 },
    './tat': { buildDayLegs: async (r) => { consumers.push(['tat', r]); return { legs: [], stats: {} }; } },
    './pay': { buildDayPay: async (r) => { consumers.push(['pay', r]); return { jobs: [], punches: [], stats: {} }; } },
    './supabase-rest': { sbDelete: async () => {}, sbUpsert: async () => {}, sbSelectAll: async () => [], supabaseConfigured: () => true, missingSupabaseEnv: () => [] },
    './pay-reconcile': { keepStoredDistances: () => {}, markPayDay: async () => {} },
    './time': { vnDate: () => '2026-09-27', addDays: () => '', vnHoursMinutes: () => ({ hours: 5, minutes: 35 }) },
  });
  const [first, second] = await Promise.all([reads.timeline('2026-09-26', 'prod'), reads.timeline('2026-09-26', 'prod')]);
  assert.equal(first, second);
  const result = await archive.archiveDay('2026-09-26', 'prod', reads);
  assert.equal(result.ok, true);
  assert.deepEqual(consumers.map(([name]) => name), ['tat', 'pay', 'eta']);
  assert.ok(consumers.every(([, seen]) => seen === routes));
  assert.deepEqual(readCalls, ['prod:2026-09-26']);
  await reads.timeline('2026-09-25', 'prod');
  await reads.timeline('2026-09-26', 'uat');
  assert.deepEqual(readCalls, ['prod:2026-09-26', 'prod:2026-09-25', 'uat:2026-09-26']);
});

test('archive failure in historical ETA leaves the day retryable', async () => {
  const archive = load('src/lib/tat-archive.ts', {
    '@upstash/redis': { Redis: class {} },
    './cartrack': { getTimelineRoutes: async () => [] },
    './pickup-setup': { pickupEtaRows: () => [], writePickupEta: async () => { throw new Error('stub write failed'); } },
    './tat': { buildDayLegs: async () => ({ legs: [], stats: {} }) },
    './pay': { buildDayPay: async () => ({ jobs: [], punches: [], stats: {} }) },
    './supabase-rest': { sbDelete: async () => {}, sbUpsert: async () => {}, sbSelectAll: async () => [], supabaseConfigured: () => true, missingSupabaseEnv: () => [] },
    './pay-reconcile': { keepStoredDistances: () => {}, markPayDay: async () => {} },
    './time': { vnDate: () => '2026-09-27', addDays: () => '', vnHoursMinutes: () => ({ hours: 5, minutes: 35 }) },
  });
  const result = await archive.archiveDay('2026-09-26', 'prod');
  assert.equal(result.ok, false);
  assert.match(result.error, /pickup ETA/);
  assert.equal(result.pay.jobs, 0);
});

test('cron starts assignment while archive write is still pending and archives when disarmed', async () => {
  let finishArchive;
  const archiveWait = new Promise(resolve => { finishArchive = resolve; });
  let assignmentStarted = false;
  let armed = true;
  const callbacks = [];
  const route = load('src/app/api/assign/cron/route.ts', {
    'next/server': { NextResponse: { json: data => data }, after: cb => callbacks.push(cb) },
    '@/lib/run-cycle': { runArmedCycle: async () => { assignmentStarted = true; } },
    '@/lib/smart-log-kv': { getArmState: async () => armed ? { env: 'prod' } : null, acquireCycleLock: async () => true, releaseCycleLock: async () => {}, setCronHeartbeat: async () => {} },
    '@/lib/auto-arm': { autoArmIfDue: async () => null },
    '@/lib/disarm-alert': { maybeAlertHeldOff: async () => {} },
    '@/lib/tat-archive': { archiveSealedDays: async () => { await archiveWait; return null; } },
    '@/lib/geofence-bypass': { restoreExpiredGeofences: async () => 0 },
    '@/lib/morning-reads': { createMorningReads: () => ({}) },
  });
  await route.GET({ headers: { get: () => null } });
  const cycle = callbacks.at(-1)();
  await Promise.resolve();
  assert.equal(assignmentStarted, true);
  finishArchive();
  await cycle;
  callbacks.length = 0;
  armed = false;
  await route.GET({ headers: { get: () => null } });
  assert.ok(callbacks.length >= 1);
  await Promise.all(callbacks.map(cb => cb()));
});
