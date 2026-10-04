// Run: npx tsx scripts/config-day-toggle.test.mts. All network calls are mocked.
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveConfigDay } from "../src/lib/config-day";
import { GET } from "../src/app/api/config/rows/route";
import { POST as saveBatch } from "../src/app/api/config/save-batch/route";
import { completeConfigRow, currentConfigTab, CONFIG_TABS, bulkUpdateConfigRows, bulkDeleteConfigRows, replaceConfigDriver, deleteConfigRow, adjustConfigRowWindow } from "../src/lib/sheets-writer";
import { MasterProfileEditor, profilePatch } from "../src/components/master-profile-editor";

const RealDate = Date;
let today = "2026-10-04T05:00:00Z"; // Sunday in Vietnam.
globalThis.Date = class extends RealDate {
  constructor(value?: string | number) { super(value ?? today); }
  static now() { return new RealDate(today).getTime(); }
} as typeof Date;
Object.assign(process.env, { MASTER_CLIENT_INFO_SOURCE: "supabase", SUPABASE_URL: "https://supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "test-only" });
delete process.env.KV_REST_API_URL; delete process.env.UPSTASH_REDIS_REST_URL;
const pickup = "11111111-1111-4111-8111-111111111111", driver = "22222222-2222-4222-8222-222222222222";
const rule = { id: 1, source_row: 2, revision: 3, assignment_mode: "fixed", row_data: {},
  pickup_customer_id: pickup, dropoff_customer_id: null, alternate_dropoff_customer_id: null,
  shift_start: "07:00:00", shift_end: "12:00:00", review_issues: [], master_rule_drivers: [{driver_id: driver, selection_order: 0}] };
let sheetFailure = false, emptySheet = false, sheetReads = 0, writes = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://docs.google.com/")) {
    sheetReads++;
    if (sheetFailure) throw new Error("Sunday source unavailable");
    return new Response("customer_id,driver_id,smart_driver_id,Driver,shift_start,shift_end,Điểm Pick-up\n" +
      (emptySheet ? "" : `${pickup},${driver},,Sunday driver,08:00,10:00,Sunday location`));
  }
  assert.ok(url.startsWith("https://supabase.invalid/"), "No live network requests");
  if (url.includes("rpc/master_write_rules")) { writes++; return Response.json([{id: 1, source_row: 2, revision: 4}]); }
  assert.equal(init?.method, "GET");
  if (url.includes("master_config_rules")) return Response.json([rule]);
  if (url.includes("master_clients")) return Response.json([{customer_id: pickup, customer_name: "Weekday location"}]);
  if (url.includes("master_drivers")) return Response.json([{driver_id: driver, first_name: "Driver", last_name: "", is_active: true}]);
  throw new Error("Unexpected mocked request");
};
const read = async (query: string) => {
  const res = await GET(new NextRequest(`http://test.invalid/api/config/rows${query}`));
  return {status: res.status, ...await res.json()};
};
const save = (config_day?: string) => saveBatch(new NextRequest("http://test.invalid/api/config/save-batch", {method: "POST", body: JSON.stringify({config_day, branches: [{pickup_name: "Weekday location", pickup_customer_id: pickup, rows: [{row: 2, driver: "Driver", start: "07:00", end: "11:00", dropoff: "", assignment_mode: "fixed", expected_row: {rule_id: 1, revision: 3, driver: "Driver", start: "07:00", end: "12:00", dropoff: ""}}], removed: []}]})}));
try {
  assert.equal(resolveConfigDay(), "sunday");
  assert.equal(currentConfigTab("weekday"), CONFIG_TABS.weekday);
  assert.equal(currentConfigTab("sunday"), CONFIG_TABS.sunday);
  assert.throws(() => resolveConfigDay("other"));
  const weekday = await read("?day=weekday");
  assert.equal(weekday.tab, "Supabase"); assert.equal(weekday.rows[0].pickup, "Weekday location");
  sheetFailure = true;
  const failedSunday = await read("?day=sunday");
  assert.equal(failedSunday.status, 500); assert.deepEqual(failedSunday.rows, [], "Must not serve weekday data after Sunday failure");
  sheetFailure = false;
  assert.equal((await read("?day=sunday")).rows[0].pickup, "Sunday location");
  const reads = sheetReads;
  assert.equal((await read("?day=weekday")).cached, true);
  assert.equal((await read("?day=sunday")).cached, true); assert.equal(sheetReads, reads);
  sheetFailure = true;
  assert.equal((await read("?day=sunday&fresh=1")).rows[0].pickup, "Sunday location");
  sheetFailure = false; emptySheet = true;
  assert.equal((await read("?day=sunday&fresh=1")).rows[0].pickup, "Sunday location");
  assert.equal((await read("?day=invalid")).status, 400);
  assert.equal((await save("weekday")).status, 200, "Explicit weekday save works on Sunday");
  assert.equal(writes, 1);
  assert.equal((await save("sunday")).status, 409); assert.equal((await save()).status, 409); assert.equal(writes, 1);
  today = "2026-10-05T05:00:00Z";
  assert.equal(resolveConfigDay(), "weekday"); assert.equal((await read("")).day, "weekday");
  const target = {row: 3, expectPickup: "Sunday location"};
  for (const action of [
    () => completeConfigRow({...target, config_day: "sunday", driverName: "Driver"}),
    () => bulkUpdateConfigRows({targets: [target], config_day: "sunday", start: "09:00"}),
    () => bulkDeleteConfigRows({targets: [target], config_day: "sunday"}),
    () => replaceConfigDriver({targets: [target], config_day: "sunday", from: "Driver", to: "Other"}),
    () => deleteConfigRow({...target, config_day: "sunday"}),
    () => adjustConfigRowWindow({...target, config_day: "sunday", edge: "start", value: "09:00"}),
  ]) await assert.rejects(action, /Chủ nhật/);
  assert.equal(writes, 1, "Sunday edits never reach Supabase");
  const html = renderToStaticMarkup(createElement(MasterProfileEditor, {kind: "client", id: pickup, initial: {customer_name: "{inactive} Location"}, clients: [], onCancel() {}, async onSaved() {}}));
  assert.match(html, /role="switch" aria-checked="false"/);
  assert.ok(html.includes("Bấm Lưu và đồng bộ để áp dụng"));
  assert.deepEqual(profilePatch("client", {customer_name: "{inactive} Location"}, {is_active: "true"}, true), {is_active: true});
  console.log("PASS: selected sources, isolated caches, Sunday write protection, weekday save on Sunday, and staged hover status");
} finally { globalThis.fetch = originalFetch; globalThis.Date = RealDate; }
