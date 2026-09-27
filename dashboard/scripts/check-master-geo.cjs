const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/lib/master-geo.ts"), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const geoExports = {};
const wards = [{ n: "Test", p: "Province", c: [[[[0, 0], [4, 0], [4, 4], [0, 4]], [[1, 1], [2, 1], [2, 2], [1, 2]]]] }];
const psc = [
  { pickup: "00000000-0000-0000-0000-000000000000", psc_pickup: "D000", lat: 0, lon: 0 },
  { pickup: "11111111-1111-1111-1111-111111111111", psc_pickup: "D021", lat: 3, lon: 3 },
  { pickup: "22222222-2222-2222-2222-222222222222", psc_pickup: "D023", lat: 9, lon: 9 },
];
vm.runInNewContext(js, {
  exports: geoExports,
  require(name) {
    if (name === "@/data/wards.json") return wards;
    if (name === "./distance") return { haversineKm: (a, b, c, d) => Math.hypot(a - c, b - d) };
    if (name === "./psc-routes-data") return { PSC_ROUTES: psc };
    throw new Error(name);
  },
});
assert.equal(geoExports.newWard(3, 3), "Test, Province");
assert.equal(geoExports.newWard(1.5, 1.5), null);
assert.equal(geoExports.newWard(5, 5), null);
geoExports.nearestPsc(0, 0).then((result) => {
  assert.equal(result.name, "D021");
  const syncSource = fs.readFileSync(path.join(__dirname, "../src/lib/master-sync.ts"), "utf8");
  const syncJs = ts.transpileModule(syncSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const syncExports = {};
  vm.runInNewContext(syncJs, { exports: syncExports, require: () => ({}) });
  assert.equal(syncExports.stableJson({ a: 1, b: { x: 2, y: 3 } }), syncExports.stableJson({ b: { y: 3, x: 2 }, a: 1 }));
  assert.notEqual(syncExports.stableJson({ a: 1 }), syncExports.stableJson({ a: 2 }));
  console.log("Master Client Info self-check passed");
});
