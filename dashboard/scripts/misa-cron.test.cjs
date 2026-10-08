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
  const events = [];
  let scheduleFails = false;
  const schedule = load('src/app/api/schedule-job/route.ts', {
    'next/server': next,
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

  for (const req of [request(), request('', false), request('?mode=retry'), request('?env=uat')]) {
    events.length = 0;
    assert.equal((await schedule.POST(req)).status, 200);
    assert.deepEqual(events, ['jobs', 'saved'], 'Job creation never dispatches GitHub or morning data sync');
  }
  scheduleFails = true;
  events.length = 0;
  assert.equal((await schedule.GET(request())).status, 500);
  assert.deepEqual(events, ['jobs']);
  console.log('Schedule checks passed: cron/manual/retry isolation from morning data sync.');
})().catch(error => { console.error(error); process.exitCode = 1; });
