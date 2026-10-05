// Offline: node scripts/pickup-setup-auto.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Print a read-only PostgreSQL check using the actual migration's calculation:
// node scripts/pickup-setup-auto.test.cjs --sql
if (process.argv.includes('--sql')) {
  const migration = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261005074229_pickup_eta_outliers.sql'), 'utf8');
  const query = migration.slice(migration.indexOf('with samples'), migration.indexOf(';', migration.indexOf('with samples')));
  const groups = { single: [45, 45, 45, 45, 45, 45, 500], sparse: [45, 45, 45, 45, 45, 500], slow: [300, 300, 300, 300, 300, 300], spread: [40, 45, 50, 55, 60, 65, 70] };
  const values = Object.entries(groups).flatMap(([id, mins]) => mins.map((m, i) => `('${id}', '${id}', date '2026-10-01' + ${i % 3}, ${m})`)).join(',');
  const fixture = query.replace(/with samples as \([\s\S]*?\), medians as \(/, `with samples(pickup_customer_id,pickup_name,trip_date,mins) as (values ${values}), medians as (`);
  console.log(`with stats as (${fixture}) select count(*)=3 and bool_and(case pickup_customer_id when 'single' then n=6 and p80_mins=45 and sample_days=3 when 'slow' then n=6 and p80_mins=300 when 'spread' then n=7 and p80_mins=64 else false end) as all_checks_passed from stats;`);
} else {

function load(file, deps) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(id => {
    if (!(id in deps)) throw new Error(`Unexpected dependency: ${id}`);
    return deps[id];
  }, mod, mod.exports);
  return mod.exports;
}

async function main() {
  const pick = '11111111-1111-4111-8111-111111111111';
  const drop = '22222222-2222-4222-8222-222222222222';
  const setup = Array.from({ length: 15 }, (_, i) => ({ lc_location_id: i + 1,
    pick_id: pick, pick_name: `P${i + 1}`, drop_location_id: 560, drop_id: drop, drop_name: 'Lab', eta_mins: 30 }));
  const pushed = [], committed = [];
  let changed = false;
  const api = load('src/lib/pickup-setup.ts', {
    './job-filters': { isChamCong: () => false }, './smart-rank': { isPlanStop: () => false },
    './master-reconcile': { UUID: /^[0-9a-f-]{36}$/ }, './time': {},
    './labcenter': {
      getAdminToken: async () => 'test',
      listPickDropLocations: async () => setup.map(s => ({ ...s, eta_mins: s.lc_location_id === 15 ? 40 : 30 })),
      updatePickDropLocation: async w => {
        pushed.push(w); assert.equal(w.expectedEtaMins, 30); assert.equal(w.dropLocationId, 560);
        return w.lcLocationId === 1 ? { ok: false, error: 'write failed' } : { ok: true };
      },
    },
    './supabase-rest': {
      sbSelectAll: async () => setup.map(s => ({ ...s })), sbUpsert: async () => {},
      sbSelect: async (table, query) => {
        if (table === 'pickup_eta_stats_30d') return [{ pickup_customer_id: pick, n: 18, median_mins: 45, p80_mins: 68, sample_days: 7 }];
        if (table === 'master_clients') return [{ customer_id: pick }, { customer_id: drop }];
        const id = Number(query.split('eq.')[1]);
        return [{ ...setup.find(s => s.lc_location_id === id), eta_mins: changed ? 35 : 30 }];
      },
      sbRpc: async (name, payload) => {
        assert.equal(name, 'commit_pickup_setup'); assert.equal(payload.expected.eta_mins, 30);
        assert.equal(payload.item.eta_mins, 70); committed.push(payload);
      },
    },
  });
  const result = await api.autoUpdatePickupEtas();
  assert.equal(result.remaining, 4); // Ten attempted, four next batch; drift is blocked.
  assert.equal(result.results.length, 10);
  assert.equal(result.results.filter(r => !r.ok).length, 1);
  assert.equal(pushed.length, 10); assert.equal(committed.length, 9);
  assert.ok(pushed.every(w => w.lcLocationId !== 15));
  const skipped = await api.autoUpdatePickupEtas([1, 2, 3, 4]);
  assert.equal(skipped.remaining, 0);
  changed = true;
  const [proposal] = api.etaProposals(setup, [{ pickup_customer_id: pick, n: 18, median_mins: 45, p80_mins: 68, sample_days: 7 }]);
  const stale = await api.applySetupAction({ action: 'approve_eta', lc_location_id: 1, mins: 70 }, proposal);
  assert.equal(stale.ok, false); assert.equal(pushed.length, 20);

  // Real Labcenter wrapper: drift rejects BEFORE a POST, and failed read-back is not success.
  const lc = load('src/lib/labcenter.ts', {});
  const originalFetch = globalThis.fetch;
  let posts = 0, liveEta = 35, liveDrop = 560, acceptWrite = true;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') { posts++; if (acceptWrite) liveEta = 70; return Response.json({}); }
    return Response.json({ data: [{ pick_location_id: 1, drop_location_id: liveDrop, estimate_pick_up: liveEta }] });
  };
  try {
    const w = { pickId: pick, dropId: drop, etaMins: 70, lcLocationId: 1, dropLocationId: 560, expectedEtaMins: 30 };
    assert.equal((await lc.updatePickDropLocation(w, 'test')).ok, false); assert.equal(posts, 0);
    liveEta = 30; liveDrop = 561;
    assert.equal((await lc.updatePickDropLocation(w, 'test')).ok, false); assert.equal(posts, 0);
    liveDrop = 560; acceptWrite = false;
    assert.equal((await lc.updatePickDropLocation(w, 'test')).ok, false); assert.equal(posts, 1);
    acceptWrite = true;
    assert.equal((await lc.updatePickDropLocation(w, 'test')).ok, true); assert.equal(posts, 2);
  } finally { globalThis.fetch = originalFetch; }

  // Daily gate: no work outside the window, mutual exclusion, failed rows don't starve the queue.
  const values = new Map(); let locked = false, calls = 0, minute = 359;
  const cron = load('src/lib/pickup-setup-auto.ts', {
    './time': { vnDate: () => '2026-10-05', vnMinutesSinceMidnight: () => minute },
    './tat-archive': { LOCK_TTL_S: 90, getRedis: () => ({
      get: async key => values.get(key),
      set: async (key, value, opts) => {
        if (opts.nx) { if (locked) return null; locked = true; return 'OK'; }
        values.set(key, value); return 'OK';
      },
    }) },
    './pickup-setup': { autoUpdatePickupEtas: async skipped => {
      calls++;
      if (calls === 1) { assert.deepEqual(skipped, []); return { remaining: 1, results: [{ lc_location_id: 1, ok: false, error: 'test failure' }] }; }
      assert.deepEqual(skipped, [1]); return { remaining: 0, results: [{ lc_location_id: 2, ok: true }] };
    } },
  });
  await cron.maybeAutoUpdatePickupEtas(); assert.equal(calls, 0);
  minute = 360; await cron.maybeAutoUpdatePickupEtas(); assert.equal(calls, 1);
  await cron.maybeAutoUpdatePickupEtas(); assert.equal(calls, 1);
  locked = false; await cron.maybeAutoUpdatePickupEtas(); assert.equal(calls, 2);
  locked = false; await cron.maybeAutoUpdatePickupEtas(); assert.equal(calls, 2);
  minute = 420; await cron.maybeAutoUpdatePickupEtas(); assert.equal(calls, 2);
  console.log('pickup-setup-auto: batch, drift, verified writes and daily gate passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
}
