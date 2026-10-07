// Run: node --test scripts/return-psc-exclusions.test.cjs. All service calls are mocked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const excluded = [
  '4daa0bca-2d7b-11f1-9378-fa163ee8d8ac', // D051
  'e6f95bb6-9c5a-11f1-9378-fa163ee8d8ac', // D052
  '41c2df14-b7bc-11f1-9378-fa163ee8d8ac', // D053
  'ada89b7e-b7cb-11f1-9378-fa163ee8d8ac', // D053
];
const otherPsc = 'a693faa0-3d8a-11ed-9fed-506b8dbc8dfb'; // D019, which visits D051 via a separate leg.

function fixture() {
  const claims = [], creates = [];
  const deps = {
    './job-filters': { PSC_RETURN_LABEL: '🛵 Vận chuyển mẫu PSC (về)' },
    './cartrack': {
      createJob: async (payload) => {
        creates.push(payload);
        return { ok: true, body: { data: { job_id: 100, delivery_driver_id: payload.delivery_driver_id } } };
      },
    },
    './time': { vnHoursMinutes: () => ({ hours: 12, minutes: 0 }) },
    './leave-config': { isDriverOnLeave: () => ({ onLeave: false }) },
    './return-suppress': { loadCleanedReturns: async () => new Map() },
    './smart-log-kv': {
      claimTripAction: async (...args) => { claims.push(args); return true; },
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/lib/return-trips.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'setTimeout', outputText)((id) => {
    assert.ok(id in deps, `Unexpected dependency: ${id}`);
    return deps[id];
  }, mod, mod.exports, () => {});
  const config = { mappings: [{ customer_id: otherPsc, smart_driver_id: ['driver'] }] };
  const outbound = (customer_id, job_id) => ({
    job_id, job_status_id: 5, delivery_driver_id: 'driver', labels: [mod.exports.PSC_OUTBOUND_LABEL],
    stops: [
      { stop_type_id: 1, customer_id }, // IDs still exclude a PSC when names are missing.
      { stop_type_id: 2, customer_id: 'hub' },
    ],
  });
  return {
    claims, creates,
    run: (ids) => mod.exports.detectAndCreateReturnTrips(config, 'prod', () => {}, {
      s2: [], s4: [], s5: ids.map(outbound),
    }),
  };
}

test('D051, D052 and both D053 records never claim or create a return, across repeated cycles', async () => {
  const f = fixture();
  await f.run(excluded);
  await f.run(excluded);
  assert.deepEqual(f.claims, []);
  assert.deepEqual(f.creates, []);
});

test('the same smart driver still receives a return for another PSC in a mixed cycle', async () => {
  const f = fixture();
  await f.run([...excluded, otherPsc]);
  assert.deepEqual(f.claims, [['return', 4, 'prod']]);
  assert.equal(f.creates.length, 1);
  assert.equal(f.creates[0].delivery_driver_id, 'driver');
  assert.deepEqual(f.creates[0].stops.map(s => s.customer_id), ['hub', otherPsc]);
});
