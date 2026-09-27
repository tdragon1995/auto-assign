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
const returnLabel = 'return', viaLabel = 'via', outboundLabel = 'outbound';
const job = { job_id: 81, job_status_id: 4, labels: [returnLabel], stops: [
  { stop_type_id: 1, stop_status_id: 1, customer_name: 'pickup' },
  { stop_type_id: 2, stop_status_id: 1, customer_name: 'dropoff' },
] };
function fixture() {
  const records = new Map();
  const calls = { labels: 0, deletes: 0, claims: 0 };
  let deleteWorks = true;
  const mod = load('src/lib/cleanup-trips.ts', {
    '@upstash/redis': { Redis: class { async get(k) { return records.get(k); } async set(k,v) { records.set(k,v); return 'OK'; } } },
    './cartrack': {
      assignJob: async () => ({}), deleteJobsFromTimeline: async () => { calls.deletes++; return deleteWorks; },
      getFleetwebCookie: async () => 'stub', getStopsByLabels: async () => { calls.labels++; return [] },
      jsonRpc: async () => ({ ok: false }), getJobsByStatusAndDate: async () => [],
    },
    './job-filters': { isStopStarted: () => false },
    './time': { vnDate: () => '2026-09-27', vnMinutesSinceMidnight: () => 12*60, parseVnTimestamp: s => new Date(s) },
    './return-trips': { PSC_RETURN_LABEL: returnLabel, PSC_OUTBOUND_LABEL: outboundLabel, isOnShift: () => false, subToCoveredDriver: () => new Map(), shiftMappingsForPsc: () => [] },
    './via-legs': { PSC_VIA_LABEL: viaLabel },
    './smart-log-kv': { claimTripAction: async () => { calls.claims++; return true; }, releaseTripClaim: async () => {} },
    './return-suppress': { recordCleanedReturns: async () => {} },
  });
  return { mod, calls, records, failDelete: () => { deleteWorks = false; }, allowDelete: () => { deleteWorks = true; } };
}

test('shared rollover pool preserves label/status exclusions and completes once', async () => {
  const oldFlag = process.env.CLEANUP_STALE_TRIPS;
  const oldUrl = process.env.KV_REST_API_URL;
  const oldToken = process.env.KV_REST_API_TOKEN;
  const oldTimer = global.setTimeout;
  process.env.CLEANUP_STALE_TRIPS = '1'; process.env.KV_REST_API_URL = 'http://stub'; process.env.KV_REST_API_TOKEN = 'stub';
  global.setTimeout = (fn,ms) => oldTimer(fn,ms).unref();
  try {
    const f = fixture();
    const pool = [job, { ...job, job_id: 82, labels: ['other'] }, { ...job, job_id: 83, job_status_id: 5 }];
    await f.mod.cleanupStaleTrips({}, 'prod', () => {}, { s2: [], s4: [], s5: [] }, [], pool);
    assert.deepEqual([f.calls.labels, f.calls.deletes, f.calls.claims], [0, 1, 1]);
    assert.ok(f.records.has('cleanup:rollover:complete:prod:2026-09-27'));
    await f.mod.cleanupStaleTrips({}, 'prod', () => {}, { s2: [], s4: [], s5: [] }, [], pool);
    assert.equal(f.calls.deletes, 1);
  } finally {
    global.setTimeout = oldTimer;
    if (oldFlag === undefined) delete process.env.CLEANUP_STALE_TRIPS; else process.env.CLEANUP_STALE_TRIPS = oldFlag;
    if (oldUrl === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = oldUrl;
    if (oldToken === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = oldToken;
  }
});

test('failed cleanup remains retryable and missing shared fields use label lookup', async () => {
  const oldFlag = process.env.CLEANUP_STALE_TRIPS;
  const oldUrl = process.env.KV_REST_API_URL;
  const oldToken = process.env.KV_REST_API_TOKEN;
  const oldTimer = global.setTimeout;
  process.env.CLEANUP_STALE_TRIPS = '1'; process.env.KV_REST_API_URL = 'http://stub'; process.env.KV_REST_API_TOKEN = 'stub';
  global.setTimeout = (fn,ms) => oldTimer(fn,ms).unref();
  try {
    const f = fixture();
    const malformed = [{ ...job, stops: null }];
    await f.mod.cleanupStaleTrips({}, 'prod', () => {}, { s2: [], s4: [], s5: [] }, [], malformed);
    assert.equal(f.calls.labels, 3);
    const g = fixture();
    g.failDelete();
    await g.mod.cleanupStaleTrips({}, 'prod', () => {}, { s2: [], s4: [], s5: [] }, [], [job]);
    assert.equal(g.records.size, 0);
    g.allowDelete();
    await g.mod.cleanupStaleTrips({}, 'prod', () => {}, { s2: [], s4: [], s5: [] }, [], [job]);
    assert.ok(g.records.has('cleanup:rollover:complete:prod:2026-09-27'));
  } finally {
    global.setTimeout = oldTimer;
    if (oldFlag === undefined) delete process.env.CLEANUP_STALE_TRIPS; else process.env.CLEANUP_STALE_TRIPS = oldFlag;
    if (oldUrl === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = oldUrl;
    if (oldToken === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = oldToken;
  }
});
