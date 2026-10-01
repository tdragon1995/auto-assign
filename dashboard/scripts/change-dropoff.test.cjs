// Run: node scripts/change-dropoff.test.cjs (no credentials or network).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const location = {
  customer_id: '11111111-1111-1111-1111-111111111111',
  customer_name: 'Bệnh viện ngoài PSC',
  address_line_1: '123 Nguyễn Trãi',
};
const psc = { ...location, customer_id: '22222222-2222-2222-2222-222222222222', customer_name: 'BRA - D001' };
let found = location, jobStatus = 4, putOk = true, listingFails = false, repeatPage = false;
const updates = [], lookups = [], pages = [];
const dependencies = {
  'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
  '@/lib/job-filters': { JOB_STATUS: { 3: 'Rejected', 5: 'Completed', 7: 'Cancelled' } },
  '@/lib/cartrack': {
    BASE_URL: 'https://cartrack.test',
    getHeaders: env => ({ Authorization: env }),
    getCustomerById: async (id, env) => { lookups.push({ id, env }); return { data: found }; },
    getJobDetails: async () => ({ data: { job_id: 42, job_status_id: jobStatus, stops: [
      { stop_id: 1, stop_type_id: 1, customer_id: 'pickup' },
      { stop_id: 2, stop_type_id: 2, customer_id: 'old-dropoff' },
    ] } }),
    updateJobStops: async (id, stops, env) => {
      updates.push({ id, stops, env });
      return { ok: putOk, status: putOk ? 200 : 422, body: {} };
    },
  },
};
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/app/api/admin/change-dropoff/route.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const handlers = {};
vm.runInNewContext(code, {
  exports: handlers,
  require: name => { assert.ok(name in dependencies, name); return dependencies[name]; },
  fetch: async (url, options) => {
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push({ page, env: options.headers.Authorization });
    if (listingFails) return new Response(null, { status: 503 });
    return Response.json({ data: page === 1 || repeatPage ? [psc] : page === 2 ? [location] : [] });
  },
});
const request = (body = {}, env = 'prod') => ({
  nextUrl: new URL(`https://example.test/api/admin/change-dropoff?env=${env}`),
  json: async () => body,
});
const body = { job_id: 42, new_dropoff_customer_id: location.customer_id };
const fast = { job_status_id: 4, pickup_stop_id: 1, pickup_customer_id: 'pickup', dropoff_stop_id: 2 };

(async () => {
  const list = await handlers.GET(request({}, 'uat'));
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).locations, [psc, location], 'PSC and non-PSC locations, including later short pages');
  assert.deepEqual(pages, [1, 2, 3].map(page => ({ page, env: 'uat' })));
  listingFails = true;
  assert.equal((await handlers.GET(request())).status, 502, 'upstream failure must not look like an empty directory');
  listingFails = false;
  repeatPage = true;
  assert.equal((await handlers.GET(request())).status, 502, 'repeated pages must not loop forever');
  repeatPage = false;

  for (const selected of [location, psc]) {
    found = selected;
    for (const metadata of [fast, {}]) {
      const res = await handlers.POST(request({ ...body, ...metadata, new_dropoff_customer_id: selected.customer_id }, 'uat'));
      assert.equal(res.status, 200, 'both fast and fallback paths accept any existing location');
      assert.equal((await res.json()).dropoff_name, selected.customer_name);
      assert.deepEqual(JSON.parse(JSON.stringify(updates.at(-1))), { id: 42, env: 'uat', stops: [
        { stop_id: 1, stop_type_id: 1, customer_id: 'pickup' },
        { stop_id: 2, stop_type_id: 2, customer_id: selected.customer_id, customer_name: selected.customer_name },
      ] }, 'preserve pickup and use the canonical location name');
      assert.equal(lookups.at(-1).env, 'uat');
    }
  }

  found = location;
  const writesBefore = updates.length;
  for (const status of [3, 5, 7]) {
    jobStatus = status;
    assert.equal((await handlers.POST(request({ ...body, ...fast, job_status_id: status }))).status, 409);
    assert.equal((await handlers.POST(request(body))).status, 409);
  }
  assert.equal(updates.length, writesBefore, 'terminal jobs must not be updated');
  found = null;
  assert.equal((await handlers.POST(request(body))).status, 400, 'unknown location must not be accepted');
  const lookupsBefore = lookups.length;
  assert.equal((await handlers.POST(request({ ...body, new_dropoff_customer_id: '../jobs/42' }))).status, 400);
  assert.equal(lookups.length, lookupsBefore, 'malformed IDs must not reach Cartrack');
  assert.equal(updates.length, writesBefore, 'invalid destinations must not change the job');
  found = location;
  putOk = false;
  assert.equal((await handlers.POST(request({ ...body, ...fast }))).status, 502, 'failed writes must be reported');
  console.log('Dropoff switching checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
