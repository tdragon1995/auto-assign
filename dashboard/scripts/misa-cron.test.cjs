// Run: node scripts/misa-cron.test.cjs (no credentials or network).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Load the real handlers with only their I/O dependencies replaced.
function load(file, dependencies, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, Response, Date, AbortSignal,
    console: { log() {}, error() {} },
    require: name => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
  }, { filename: file });
  return exports;
}
const next = { NextResponse: { json: (body, init) => Response.json(body, init) } };

(async () => {
  const env = { GITHUB_DISPATCH_TOKEN: 'test-token' };
  let latest = null, fail = false;
  const requests = [];
  const sync = load('src/lib/misa-sync.ts', { 'next/server': next }, {
    process: { env },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (fail) throw new Error('GitHub unavailable');
      if (options.method === 'POST') return new Response(null, { status: 204 });
      return Response.json({ workflow_runs: latest ? [latest] : [] });
    },
  });
  const events = [];
  let scheduleFails = false;
  const schedule = load('src/app/api/schedule-job/route.ts', {
    'next/server': next,
    '@/lib/misa-sync': { dispatchMisaSync: async () => {
      events.push('sync');
      return sync.dispatchMisaSync();
    } },
    '@/lib/schedule-job': { runScheduleJobCycle: async () => {
      events.push('jobs');
      if (scheduleFails) throw new Error('Schedule unavailable');
      return { date: '2026-09-29', weekday: 2, results: [] };
    } },
    '@/lib/schedule-job-kv': { saveLastRun: async () => events.push('saved') },
  });
  const request = (query = '', cron = true) => ({
    nextUrl: new URL(`https://example.test/api/schedule-job${query}`),
    headers: new Headers(cron ? { 'user-agent': 'vercel-cron/1.0' } : {}),
  });

  assert.equal((await schedule.GET(request())).status, 200);
  assert.deepEqual(events, ['sync', 'jobs', 'saved']);
  assert.equal(requests.filter(r => r.options.method === 'POST').length, 1);
  assert.deepEqual(JSON.parse(requests[1].options.body), { ref: 'master', inputs: {} });
  assert.ok(requests[1].url.endsWith('/misa-shifts.yml/dispatches'));

  for (const req of [request('', false), request('?mode=retry'), request('?env=uat')]) {
    events.length = 0;
    await schedule.POST(req);
    assert.deepEqual(events, ['jobs', 'saved']);
  }
  for (const status of ['queued', 'in_progress', 'completed']) {
    latest = { id: 42, conclusion: "success", status, created_at: new Date().toISOString(), html_url: 'test-run' };
    requests.length = 0;
    await schedule.GET(request());
    assert.equal(requests.length, 1, `${status}: no duplicate dispatch`);
  }
  latest.created_at = new Date(Date.now() - 16 * 60_000).toISOString();
  assert.equal((await (await sync.dispatchMisaSync()).json()).status, 'dispatched');

  fail = true;
  events.length = 0;
  assert.equal((await schedule.GET(request())).status, 200);
  assert.deepEqual(events, ['sync', 'jobs', 'saved'], 'MISA failure must not block jobs');
  fail = false;
  scheduleFails = true;
  events.length = 0;
  assert.equal((await schedule.GET(request())).status, 500);
  assert.deepEqual(events, ['sync', 'jobs'], 'Schedule failure must not prevent MISA dispatch');
  delete env.GITHUB_DISPATCH_TOKEN;
  requests.length = 0;
  assert.equal((await (await sync.dispatchMisaSync()).json()).status, 'disabled');
  assert.equal(requests.length, 0);

  const api = load('src/app/api/misa-sync/route.ts', {
    'next/server': next, '@/lib/misa-sync': sync,
  });
  env.GITHUB_DISPATCH_TOKEN = 'test-token';
  const status = await api.GET();
  assert.equal(status.status, 200);
  assert.equal((await status.json()).id, 42, 'Preserve dashboard run tracking');
  const manual = await api.POST(request('?month=2026-10', false));
  assert.equal((await manual.json()).previous_run_id, 42);
  assert.deepEqual(JSON.parse(requests.at(-1).options.body).inputs, { month: '2026-10' });
  console.log('MISA cron checks passed: daily dispatch, guards, failure isolation, manual sync.');
})().catch(error => { console.error(error); process.exitCode = 1; });
