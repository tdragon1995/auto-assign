const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const source = fs.readFileSync(require.resolve('../src/lib/pay-period.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const mod = { exports: {} };
new Function('exports', compiled.outputText)(mod.exports);
const { payrollPeriod } = mod.exports;

assert.deepEqual(payrollPeriod('2026-09'), { from: '2026-08-15', to: '2026-09-14' });
assert.deepEqual(payrollPeriod('2027-01'), { from: '2026-12-15', to: '2027-01-14' });
assert.deepEqual(payrollPeriod('2028-03'), { from: '2028-02-15', to: '2028-03-14' });

// Boundary trips belong to exactly one payroll, including leap day.
for (const [month, dates] of [
  ['2026-09', ['2026-08-14', '2026-08-15', '2026-09-14', '2026-09-15']],
  ['2028-03', ['2028-02-14', '2028-02-15', '2028-02-29', '2028-03-14', '2028-03-15']],
]) {
  const { from, to } = payrollPeriod(month);
  assert.deepEqual(dates.filter(date => date >= from && date <= to), dates.slice(1, -1));
}
console.log('Payroll periods: September, year rollover, leap year and inclusive boundaries passed.');
