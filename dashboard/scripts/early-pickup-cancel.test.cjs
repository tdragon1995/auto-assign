const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(file, deps) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/lib', file), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', outputText)(id => {
    if (id in deps) return deps[id];
    throw new Error(`Unexpected dependency: ${id}`);
  }, mod, mod.exports);
  return mod.exports;
}
const date = '2026-10-06';
const time = load('time.ts', {});
const originalNow = Date.now;
const originalEnv = { ...process.env };
const customer = '51bfb168-446f-11ed-888f-506b8dbc8dfb';
const claims = new Set();
const events = [];
let sends = 0;
const claimLateAlert = async (id, env, ttl, kind) => {
  events.push(`claim:${id}`);
  const key = `${env}:${id}:${kind}`;
  if (claims.has(key)) return false;
  claims.add(key);
  return true;
};
const reminder = load('scheduled-pickup-reminder.ts', {
  './kiot-bot': { botToken: () => 'mock' }, './schedule-job': { SCHEDULE_JOB_LABEL: '📅 Lịch cố định' },
  './smart-log-kv': { claimLateAlert }, './zalo': { sendZaloMessage: async () => { sends++; return true; } },
});
function job(id, appointment, release) {
  return {
    job_id: id, job_status_id: 4, delivery_driver_id: 'proxy', scheduled_delivery_ts: `${date} 00:00:00`,
    send_to_driver_at: `${date} ${release}:00`, labels: ['📅 Lịch cố định'],
    stops: [{ stop_type_id: 1, stop_status_id: 1, customer_id: customer, delivery_windows: [{ time_from: `${appointment}:00+07:00` }] }],
  };
}
let jobs = [job(1, '09:30', '08:30'), job(2, '15:00', '14:00')];
let cancelOk = true;
let freshStarted = false;
const cancel = load('scheduled-pickup-cancel.ts', {
  './time': time, './schedule-job': { SCHEDULE_JOB_LABEL: '📅 Lịch cố định' },
  './scheduled-pickup-reminder': reminder, './smart-log-kv': { claimLateAlert },
  './cartrack': {
    PROXY_DRIVER_ID: 'proxy', getJobsByDate: async () => jobs,
    getJobDetails: async id => {
      const fresh = structuredClone(jobs.find(job => job.job_id === id));
      if (freshStarted) fresh.stops[0].activity_started_ts = `${date} 08:00:00`;
      return { data: fresh };
    },
    cancelJobFromTimeline: async id => {
      events.push(`cancel:${id}`);
      if (cancelOk) jobs.find(job => job.job_id === id).job_status_id = 7;
      return cancelOk;
    },
  },
});
(async () => {
  try {
    Date.now = () => time.parseVnTimestamp(`${date} 08:00:00`).getTime();
    process.env.KV_REST_API_URL = 'https://redis.invalid';
    process.env.KV_REST_API_TOKEN = 'mock';
    assert.deepEqual(cancel.pickupCancellationCandidates(jobs, date, customer).map(job => job.job_id), [1]);
    assert.deepEqual(cancel.pickupCancellationCandidates(jobs, date, 'other'), []);
    assert.deepEqual(cancel.pickupCancellationCandidates(jobs, '2026-10-07', customer), []);
    const stale = structuredClone(jobs[0]);
    assert.match(await cancel.getPickupReply(customer, 'chưa có mẫu', 'mock-chat'), /Job #1/);
    assert.deepEqual(events, ['cancel:1', 'claim:1']);
    assert.equal(jobs[1].job_status_id, 4, 'later pickup stays active');
    assert.deepEqual(cancel.pickupCancellationCandidates(jobs, date, customer), [], 'repeat cannot skip the cancelled upcoming slot');
    await reminder.remindScheduledPickup(stale, 'prod', () => {});
    assert.equal(sends, 0, 'even a stale release list must not announce the cancelled pickup');
    await reminder.remindScheduledPickup(jobs[1], 'prod', () => {});
    assert.equal(sends, 1, 'later pickup reminder remains available');
    await reminder.remindScheduledPickup(jobs[0], 'prod', () => {});
    assert.equal(sends, 1, 'cancelled status cannot announce');
    jobs = [job(1, '09:30', '08:30'), job(2, '15:00', '14:00')];
    claims.clear(); events.length = 0;
    freshStarted = true;
    assert.match(await cancel.cancelScheduledPickup(customer), /đã thay đổi trạng thái/);
    assert.deepEqual(events, [], 'fresh started pickup must not cancel or suppress');
    freshStarted = false; cancelOk = false;
    assert.match(await cancel.cancelScheduledPickup(customer), /Không huỷ được/);
    assert.deepEqual(events, ['cancel:1'], 'failed cancellation must not suppress a valid reminder');
    cancelOk = true;
    const released = { ...jobs[0], delivery_driver_id: 'real-driver' };
    Date.now = () => time.parseVnTimestamp(`${date} 10:00:00`).getTime();
    assert.deepEqual(cancel.pickupCancellationCandidates([released, jobs[1]], date, customer).map(job => job.job_id), [1], 'current unstarted pickup takes priority over afternoon');
    const ambiguous = [job(3, '15:00', '14:00'), jobs[1]];
    assert.equal(cancel.pickupCancellationCandidates(ambiguous, date, customer).length, 2, 'same-time ambiguity remains guarded');
    console.log('Early cancellation and reminder suppression checks passed.');
  } finally { Date.now = originalNow; process.env = originalEnv; }
})().catch(error => { console.error(error); process.exitCode = 1; });