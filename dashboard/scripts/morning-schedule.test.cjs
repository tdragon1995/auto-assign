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
const date = '2026-09-27';
function fixture({ rows = [{ reference: 'ABC' }], stops = [], rest = async () => ({ data: [] }), create = async () => ({ ok: true, body: { data: { job_id: 901 } } }) } = {}) {
  const calls = { rpc: 0, rest: [], create: 0, park: 0 };
  const cartrack = {
    BASE_URL: 'https://cartrack.invalid', PROXY_DRIVER_ID: 'proxy', getHeaders: () => ({}),
    getStopsByLabels: async () => { calls.rpc++; return stops; },
    createJob: async (...args) => { calls.create++; return create(...args); },
    assignJob: async () => { calls.park++; return { status: 200 }; },
  };
  const sheets = {
    SHEET_GID: { schedule_job: 1 }, SHEET_CONTRACT: { schedule_job: { label: 'test' } },
    fetchSheetRows: async () => rows.map(r => ({ pickup_id: 'pick', dropoff_id: 'drop', delivery_windows: '08:00', ...Object.fromEntries(['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].map(d => [d, 'true'])), ...r })),
    isSheetShapeError: () => false, noteSheetLoad: () => {},
  };
  const mod = load('src/lib/schedule-job.ts', { './cartrack': cartrack, './sheets': sheets, './time': { vnDate: () => date, vnTimestamp: () => '2026-09-27 07:00:00' } });
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = new URL(url);
    calls.rest.push(u);
    const response = await rest(u, calls);
    return Response.json(response.body ?? response, { status: response.status ?? 200 });
  };
  return { mod, calls, restore: () => { global.fetch = original; } };
}

test('one RPC hit skips creation and REST', async () => {
  const f = fixture({ stops: [{ reference_number: `ABC_${date}`, job_id: 42 }] });
  try {
    const out = await f.mod.runScheduleJobCycle('prod');
    assert.equal(out.results[0].status, 'SKIPPED');
    assert.deepEqual([f.calls.rpc, f.calls.rest.length, f.calls.create], [1, 0, 0]);
  } finally { f.restore(); }
});

test('RPC miss searches exact reference without date and ignores similar results', async () => {
  const f = fixture({ rest: async () => ({ data: [{ job_id: 12, reference_number: `ABC_${date}_extra` }] }) });
  try {
    const out = await f.mod.runScheduleJobCycle('prod');
    assert.equal(out.results[0].status, 'OK');
    assert.equal(f.calls.create, 1);
    assert.equal(f.calls.rest[0].searchParams.get('filter[reference_number]'), `ABC_${date}`);
    assert.equal([...f.calls.rest[0].searchParams.keys()].some(k => k.includes('date') || k.includes('ts_')), false);
  } finally { f.restore(); }
});

test('re-dated job is still found by exact REST reference', async () => {
  const f = fixture({ stops: null, rest: async () => ({ data: [{ job_id: 71, reference_number: `ABC_${date}`, scheduled_delivery_ts: '2026-09-28' }] }) });
  try {
    const out = await f.mod.runScheduleJobCycle('prod');
    assert.equal(out.results[0].job_id, 71);
    assert.equal(f.calls.create, 0);
  } finally { f.restore(); }
});

test('pagination reaches a later exact match', async () => {
  const f = fixture({ rest: async (u) => Number(u.searchParams.get('page')) === 1
    ? { data: Array.from({ length: 100 }, (_, i) => ({ job_id: i+1, reference_number: `ABC_${date}_${i}` })) }
    : { data: [{ job_id: 401, reference_number: `ABC_${date}` }] } });
  try {
    assert.equal(await f.mod.findScheduledJobByReference(`ABC_${date}`, 'prod'), 401);
    assert.equal(f.calls.rest.length, 2);
  } finally { f.restore(); }
});

test('empty search allows creation; failed and malformed searches fail closed', async () => {
  for (const result of [{ data: [] }, { body: {}, status: 200 }, { body: { data: [] }, status: 500 }, { body: { data: [], meta: { last_page: 'broken' } }, status: 200 }]) {
    const f = fixture({ rest: async () => result });
    try {
      const out = await f.mod.runScheduleJobCycle('prod');
      assert.equal(out.results[0].status, result.data ? 'OK' : 'ERROR');
      assert.equal(f.calls.create, result.data ? 1 : 0);
    } finally { f.restore(); }
  }
});

test('duplicate rows share one create and park', async () => {
  const f = fixture({ rows: [{ reference: 'ABC' }, { reference: 'ABC' }] });
  try {
    const out = await f.mod.runScheduleJobCycle('prod');
    assert.deepEqual(out.results.map(r => r.status).sort(), ['OK', 'SKIPPED']);
    assert.deepEqual([f.calls.rpc, f.calls.create, f.calls.park], [1, 1, 1]);
  } finally { f.restore(); }
});

test('ambiguous create is followed by fresh REST search on retry', async () => {
  let landed = false;
  const f = fixture({
    rest: async () => ({ data: landed ? [{ reference_number: `ABC_${date}`, job_id: 818 }] : [] }),
    create: async () => { landed = true; return { ok: false, status: 500, body: {} }; },
  });
  try {
    const out = await f.mod.runScheduleJobCycle('prod');
    assert.equal(out.results[0].status, 'SKIPPED');
    assert.equal(out.results[0].job_id, 818);
    assert.deepEqual([f.calls.create, f.calls.rest.length], [1, 2]);
  } finally { f.restore(); }
});
