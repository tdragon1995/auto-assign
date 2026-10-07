// Run: node scripts/day-time-picker.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/components/day-time-picker.tsx'), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
});
const mod = { exports: {} };
new Function('require', 'exports', outputText)(() => ({}), mod.exports);
const originalNow = Date.now;
try {
  for (const [clock, dayOffset, timeLabel] of [
    ['00:00', 0, null], ['07:59', 0, null],
    ['08:00', 0, null], ['13:03', 0, null],
    ['18:59', 0, null], ['19:00', 1, '08:00'], ['23:59', 1, '08:00'],
  ]) {
    Date.now = () => new Date(`2026-10-07T${clock}:00+07:00`).getTime();
    assert.deepEqual(mod.exports.defaultSchedule(), { dayOffset, timeLabel }, clock);
  }
  for (let minute = 0; minute < 24 * 60; minute++) {
    Date.now = () => new Date('2026-10-07T00:00:00+07:00').getTime() + minute * 60_000;
    const { dayOffset, timeLabel } = mod.exports.defaultSchedule();
    assert.equal(dayOffset, minute >= 19 * 60 ? 1 : 0);
    assert.equal(timeLabel, dayOffset === 1 ? '08:00' : null);
    assert.equal(mod.exports.isTimePast(dayOffset, timeLabel), false);
  }
  Date.now = () => new Date('2026-10-07T13:00:00+07:00').getTime();
  assert.deepEqual(mod.exports.defaultSchedule(1), { dayOffset: 1, timeLabel: '08:00' });
  assert.deepEqual(mod.exports.defaultSchedule(0), { dayOffset: 0, timeLabel: null });
  assert.deepEqual(mod.exports.defaultSchedule(2), { dayOffset: 2, timeLabel: null });
} finally { Date.now = originalNow; }
console.log('Scheduler defaults passed at every VN minute, including 19:00 and midnight.');