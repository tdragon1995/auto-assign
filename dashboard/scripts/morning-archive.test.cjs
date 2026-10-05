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
  let autoEtaChecks = 0;
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
    '@/lib/morning-recovery': { recoverMorning: async () => {} },
    '@/lib/pickup-setup-auto': { maybeAutoUpdatePickupEtas: async () => { autoEtaChecks++; } },
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
  assert.equal(autoEtaChecks, 1); // Still scheduled while assignment is disarmed.
});

function redisMemory() {
  const values = new Map();
  let clock = 0;
  const get = (key) => {
    const r = values.get(key);
    if (!r || r.expires <= clock) { values.delete(key); return null; }
    return r;
  };
  return {
    advance: (ms) => { clock += ms; },
    async get(key) { return structuredClone(get(key)?.value ?? null); },
    async ttl(key) { const r = get(key); return r ? Math.ceil((r.expires - clock) / 1000) : -2; },
    async set(key, value, opts = {}) {
      if (opts.nx && get(key) || opts.xx && !get(key)) return null;
      values.set(key, { value: structuredClone(value), expires: clock + (opts.ex ?? 86400) * 1000 });
      return 'OK';
    },
    async del(key) { values.delete(key); },
  };
}

test('a killed archive resumes after its last completed output', async () => {
  const redis = redisMemory();
  const oldUrl = process.env.KV_REST_API_URL, oldToken = process.env.KV_REST_API_TOKEN;
  process.env.KV_REST_API_URL = 'http://stub'; process.env.KV_REST_API_TOKEN = 'stub';
  let tatCalls = 0, payCalls = 0, etaCalls = 0, reachedPay;
  const payStarted = new Promise(resolve => { reachedPay = resolve; });
  let killed = true;
  const deps = {
    '@upstash/redis': { Redis: class { constructor() { return redis; } } },
    './cartrack': { getTimelineRoutes: async () => [] },
    './pickup-setup': { pickupEtaRows: () => [], writePickupEta: async () => { etaCalls++; return 0; } },
    './tat': { buildDayLegs: async () => { tatCalls++; return { legs: [], stats: {} }; } },
    './pay': { buildDayPay: async () => { payCalls++; if (killed) { reachedPay(); return new Promise(() => {}); } return { jobs: [], punches: [], stats: {} }; } },
    './supabase-rest': { sbDelete: async () => {}, sbUpsert: async () => {}, sbSelectAll: async () => [], supabaseConfigured: () => true, missingSupabaseEnv: () => [] },
    './pay-reconcile': { keepStoredDistances: () => {}, markPayDay: async () => {} },
    './time': load('src/lib/time.ts', {}),
  };
  try {
    const first = load('src/lib/tat-archive.ts', deps);
    void first.archiveSealedDays('prod', new Date('2026-09-27T05:35:00+07:00'));
    await payStarted; // simulate process death here: neither finally nor seal promotion runs
    assert.ok(await redis.ttl('tat:sealed:prod:2026-09-26') <= 90);
    redis.advance(91_000);
    killed = false;
    const restarted = load('src/lib/tat-archive.ts', deps);
    const out = await restarted.archiveSealedDays('prod', new Date('2026-09-27T05:38:00+07:00'));
    assert.equal(out.ok, true);
    assert.deepEqual([tatCalls, payCalls, etaCalls], [1, 2, 1]);
    assert.ok(await redis.ttl('tat:sealed:prod:2026-09-26') > 90);
  } finally {
    if (oldUrl === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = oldUrl;
    if (oldToken === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = oldToken;
  }
});

test('consecutive pings recover a killed schedule run, then email only unresolved work', async () => {
  const redis = redisMemory();
  let saved = null, runs = 0, sends = 0, refuseEmail = true;
  const keys = [];
  const payloads = [];
  const module = load('src/lib/morning-recovery.ts', {
    './tat-archive': { getRedis: () => redis, LOCK_TTL_S: 90, TAT_LOOKBACK_DAYS: 3 },
    './schedule-job-kv': { getLastRun: async () => saved, saveLastRun: async (r) => { saved = r; } },
    './schedule-job': { runScheduleJobCycle: async () => { runs++; return { date: '2026-09-27', weekday: 0, results: [{ status: 'OK', job_id: 1 }] }; } },
    './smart-log-kv': { getArmState: async () => ({ env: 'prod' }) },
    './disarm-alert': { sendResendEmail: async (_key, body, idempotency) => { sends++; keys.push(idempotency); payloads.push(body); assert.match(body.html, /Archive/); if (refuseEmail) throw new Error('email service unavailable'); } },
    './time': load('src/lib/time.ts', {}),
  });
  const at = (time) => new Date(`2026-09-27T${time}:00+07:00`);
  const oldKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'stub';
  try {
    await module.recoverMorning(at('05:02'));
    await redis.set('schedule_job:retry:prod:2026-09-27', 'killed', { ex: 90 });
    await module.recoverMorning(at('05:05')); // prior invocation still leased
    assert.equal(runs, 0);
    redis.advance(91_000);
    await module.recoverMorning(at('05:07'));
    await module.recoverMorning(at('05:10')); // successful schedule is not read again
    assert.equal(runs, 1);
    await module.recoverMorning(at('06:04'));
    assert.equal(sends, 0);
    await assert.rejects(module.recoverMorning(at('06:05')), /email service unavailable/);
    await redis.set('tat:sealed:prod:2026-09-26', 'done', { ex: 604800 });
    refuseEmail = false;
    await module.recoverMorning(at('06:08'));
    await module.recoverMorning(at('06:11'));
    assert.equal(sends, 2); // one failed delivery, one accepted; no third email
    assert.equal(keys[0], keys[1]);
    assert.deepEqual(payloads[0], payloads[1]); // status changes cannot change a retry's payload
  } finally {
    if (oldKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = oldKey;
  }
});

test('completed mornings stay quiet; disarmed operation still checks the archive', async () => {
  const redis = redisMemory();
  for (const date of ['2026-09-26','2026-09-25','2026-09-24']) await redis.set(`tat:sealed:prod:${date}`, 'done', { ex: 604800 });
  const { recoverMorning } = load('src/lib/morning-recovery.ts', {
    './tat-archive': { getRedis: () => redis, LOCK_TTL_S: 90, TAT_LOOKBACK_DAYS: 3 },
    './schedule-job-kv': { getLastRun: async () => ({ date: '2026-09-27', results: [] }) },
    './schedule-job': { runScheduleJobCycle: async () => { throw new Error('completed schedule must not run'); } },
    './smart-log-kv': { getArmState: async () => null },
    './disarm-alert': { sendResendEmail: async () => { throw new Error('healthy morning must not email'); } },
    './time': load('src/lib/time.ts', {}),
  });
  await recoverMorning(new Date('2026-09-27T05:02:00+07:00'));
  await recoverMorning(new Date('2026-09-27T06:05:00+07:00'));
  assert.equal(await redis.get('morning:checked:2026-09-27'), 'done');
});

test('rollover failures remain unfinished and a later pass resumes them', async () => {
  let failing = true;
  const deps = new Proxy({
    './cartrack': {
      unassignJob: async (id) => ({ ok: !failing || id !== 4, status: 500 }),
      updateJobScheduledDeliveryTs: async (id) => { if (failing && id === 3) throw new Error('connection lost'); return { ok: !failing || id !== 2, status: 500 }; },
    },
    './job-filters': { isChamCong: () => false, isCompletedOrRejectedStop: () => false },
  }, { has: () => true, get: (target, key) => target[key] ?? {} });
  const { rolloverUnfinishedJobs } = load('src/lib/assign.ts', deps);
  const candidates = [1,2,3,4].map(job_id => ({ job_id, delivery_driver_id: job_id === 4 ? 'driver' : null, stops: [] }));
  const first = await rolloverUnfinishedJobs(candidates, '2026-09-27', 'prod', () => {}, Date.now() + 1000);
  assert.deepEqual([...first.bumped], [1]);
  assert.equal(first.remaining, 3);
  failing = false;
  const second = await rolloverUnfinishedJobs(candidates.filter(j => !first.bumped.has(j.job_id)), '2026-09-27', 'prod', () => {}, Date.now() + 1000);
  assert.equal(second.remaining, 0);
  const timedOut = await rolloverUnfinishedJobs(candidates, '2026-09-27', 'prod', () => {}, Date.now() - 1);
  assert.equal(timedOut.remaining, 4);
});
