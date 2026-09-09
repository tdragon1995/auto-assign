// Run: node --test scripts/psc-tinh-time.test.cjs. All service calls are mocked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(file, deps = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', outputText)((id) => {
    if (id in deps) return deps[id];
    throw new Error(`Unexpected dependency: ${id}`);
  }, mod, mod.exports);
  return mod.exports;
}
const time = load('src/lib/time.ts');
const helpers = load('src/lib/psc-tinh-time.ts', { './time': time });

test('picker crosses year-end midnight with dated, five-minute slots', () => {
  const days = helpers.buildPscTinhTimeSlots(new Date('2026-12-31T23:51:00+07:00'));
  assert.deepEqual(days[0].slots.map(s => s.value), ['2026-12-31T23:55']);
  assert.equal(days[1].slots.length, 288);
  assert.deepEqual(days[1].slots[0], { value: '2027-01-01T00:00', label: '00:00 — Ngày mai · 01/01' });
  assert.equal(days[1].slots.at(-1).value, '2027-01-01T23:55');
});

test('midnight follows Vietnam time regardless of host timezone', () => {
  const days = helpers.buildPscTinhTimeSlots(new Date('2026-09-09T17:00:00Z'));
  assert.equal(days[0].date, '2026-09-10');
  assert.equal(days[0].slots[0].value, '2026-09-10T00:05');
  assert.equal(days[1].date, '2026-09-11');
});

test('last minute still offers all of tomorrow and no elapsed slots', () => {
  const days = helpers.buildPscTinhTimeSlots(new Date('2026-09-09T23:59:00+07:00'));
  assert.equal(days[0].slots.length, 0);
  assert.equal(days[1].slots.length, 288);
});

test('schedule rejects stale selections and preserves an absolute date across midnight', () => {
  const now = new Date('2026-09-09T23:59:00+07:00');
  assert.deepEqual(helpers.pscTinhSchedule('00:05', '2026-09-10', now).fields,
    { schedule_type_id: 2, scheduled_delivery_ts: '2026-09-10 00:00:00' });
  assert.deepEqual(helpers.pscTinhSchedule('00:05', '2026-09-10', new Date('2026-09-10T00:01:00+07:00')).fields,
    { schedule_type_id: 1 });
  for (const [eta, date] of [['23:55', '2026-09-09'], ['24:00', '2026-09-10'], ['12:00', '2026-09-11'], ['12:00', null]]) {
    assert.throws(() => helpers.pscTinhSchedule(eta, date, now));
  }
  assert.deepEqual(helpers.pscTinhSchedule('23:59', undefined, new Date('2026-09-09T23:58:00+07:00')).fields,
    { schedule_type_id: 1 });
});

function routeFixture(rest = false) {
  const calls = [];
  const route = load('src/app/api/psc-tinh/route.ts', {
    'next/server': { NextResponse: { json: (data, init) => Response.json(data, init) } },
    '@/lib/time': time,
    '@/lib/psc-tinh-time': helpers,
    '@/lib/psc-config': { PSC_TINH_LABEL: 'test-label', loadTplEntries: async () => [] },
    '@/lib/job-filters': { STOP_STATUS: {}, JOB_STATUS: { 2: 'Unassigned' } },
    '@/lib/job-detail': { fetchJobDetail: async () => null },
    '@/lib/cartrack': {
      BASE_URL: 'https://cartrack.invalid', getHeaders: () => ({}),
      getStopsByLabels: async (date) => { calls.push(['stops', date]); return rest ? null : [
        { job_id: 123, stop_type_id: 1, reference_number: 'BRA - KGIANG - Mẫu 4', job_status_id: 2, delivery_windows: [{ time_from: '00:05:00+07:00' }] },
      ]; },
      createJob: async (payload) => { calls.push(['create', payload]); return { ok: true, body: { data: { job_id: 124 } } }; },
    },
    '@/lib/smart-log-kv': {
      acquireCreateLock: async (key) => { calls.push(['lock', key]); return true; },
      releaseCreateLock: async (key) => { calls.push(['unlock', key]); },
      nextOrderNumber: async (key, floor) => { calls.push(['number', key, floor]); return floor + 1; },
      pushRunLog: async () => {},
    },
  });
  return { route, calls };
}

test('tomorrow POST schedules, locks, and numbers on tomorrow without writing real jobs', async () => {
  const date = time.addDays(time.vnDate(), 1);
  const { route, calls } = routeFixture();
  const response = await route.POST({ nextUrl: new URL('https://test.invalid'), json: async () => ({
    psc_code: 'KGIANG', tpl_uuid: 'pickup-uuid', eta: '00:05', delivery_date: date,
  }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).delivery_date, date);
  assert.ok(calls.some(c => c[0] === 'stops' && c[1] === date));
  assert.deepEqual(calls.find(c => c[0] === 'number'), ['number', `KGIANG-${date}`, 4]);
  assert.deepEqual(calls.find(c => c[0] === 'lock'), ['lock', `psctinh:KGIANG-${date}`]);
  const payload = calls.find(c => c[0] === 'create')[1];
  assert.equal(payload.scheduled_delivery_ts, `${date} 00:00:00`);
  assert.equal(payload.schedule_type_id, 2);
  assert.equal(payload.reference_number, 'BRA - KGIANG - Mẫu 5');
  assert.equal(payload.stops[0].delivery_windows[0].time_from, '00:05:00+07:00');
  assert.equal(payload.stops[0].delivery_windows[0].time_to, '00:35:00+07:00');
  assert.equal(calls.at(-1)[0], 'unlock');
});

test('invalid booking date returns 400 before any service call', async () => {
  const { route, calls } = routeFixture();
  const response = await route.POST({ nextUrl: new URL('https://test.invalid'), json: async () => ({
    psc_code: 'KGIANG', tpl_uuid: 'pickup-uuid', eta: '08:00', delivery_date: '2000-01-01',
  }) });
  assert.equal(response.status, 400);
  assert.deepEqual(calls, []);
});

test('tomorrow orders survive a reload through both RPC and REST paths', async () => {
  const date = time.addDays(time.vnDate(), 1);
  for (const rest of [false, true]) {
    const { route } = routeFixture(rest);
    const originalFetch = global.fetch;
    try {
      global.fetch = async (url) => {
        assert.ok(url.includes(`filter[scheduled_delivery_ts_from]=${date} 00:00:00`));
        assert.ok(url.includes(`filter[scheduled_delivery_ts_to]=${date} 23:59:59`));
        return Response.json({ data: [{ job_id: 123, reference_number: 'BRA - KGIANG - Mẫu 4', job_status_id: 2, stops: [] }] });
      };
      const response = await route.GET({ nextUrl: new URL(`https://test.invalid?psc=KGIANG&mode=orders&date=${date}`) });
      const data = await response.json();
      assert.equal(data.orders[0].delivery_date, date);
      assert.equal(data.orders[0].job_id, 123);
    } finally { global.fetch = originalFetch; }
  }
});
