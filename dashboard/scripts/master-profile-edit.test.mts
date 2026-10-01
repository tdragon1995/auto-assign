import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MasterProfileEditor, profilePatch } from "../src/components/master-profile-editor";
import { createMasterConfigRows, ruleChange, type MasterRule } from "../src/lib/master-store";
import { editMasterConfig } from "../src/lib/master-config-actions";
import { asLine, sig, applyCopiedLines } from "../src/lib/config-shift";
import { editClient } from "../src/lib/master-profile";

const client = { address_line_1: "Old", latitude: 10.5, longitude: 106.5 };
const draft = { address_line_1: "New", latitude: "11", longitude: "107", bot_token: "not writable" };
assert.deepEqual(profilePatch("client", client, draft, true), { address_line_1: "New" });
assert.deepEqual(profilePatch("client", client, draft, false), { address_line_1: "New", latitude: 11, longitude: 107 });
assert.throws(() => profilePatch("client", client, { latitude: "invalid" }, false));
assert.deepEqual(profilePatch("driver", { shift_time_start: "07:00:00+07:00" }, { shift_time_start: "07:00", bot_token: "not writable" }, true), {});
assert.deepEqual(profilePatch("driver", {}, { shift_time_start: "08:30", end_location_customer_id: "" }, true), { shift_time_start: "08:30:00+07:00" });
assert.deepEqual(profilePatch("driver", { end_location_customer_id: "old", shift_time_end: "18:00" }, { end_location_customer_id: "", shift_time_end: "" }, true), { end_location_customer_id: null, shift_time_end: null });
const pickup = "11111111-1111-4111-8111-111111111111";
const destination = "22222222-2222-4222-8222-222222222222";
const alternate = "33333333-3333-4333-8333-333333333333";
const driver = "44444444-4444-4444-8444-444444444444";
// A saved dropoff without a Labcenter link must still be selected, never a different location.
const editorProps = {kind:"client" as const,id:pickup,initial:{default_dropoff_id:destination,default_dropoff_name:"BRA - D015"},linkedLabcenter:true,
  clients:[{customer_id:alternate,cartrack:{customer_name:"Other linked location"},labcenter_location_id:20},
    {customer_id:destination,cartrack:{customer_name:"BRA - D015"},labcenter_location_id:null},
    {customer_id:driver,cartrack:{customer_name:"Other unlinked location"},labcenter_location_id:null}],onCancel(){},async onSaved(){}};
for (const clients of [editorProps.clients,editorProps.clients.filter(c=>c.customer_id!==destination)]) {
  const html = renderToStaticMarkup(createElement(MasterProfileEditor,{...editorProps,clients}));
  assert.ok(html.includes("BRA - D015") && html.includes('role="combobox"'));
  assert.ok(html.includes("Trạng thái địa điểm") && !html.includes('aria-label="Bỏ BRA - D015"'));
  assert.ok(!html.includes("Other unlinked location"));
}
assert.deepEqual(profilePatch("client",editorProps.initial,{default_dropoff_id:destination},true),{});
const rule: MasterRule = { id: 1, source_uid: pickup, source_row: 2, revision: 7, assignment_mode: "smart",
  row_data: { bot_token: "preserve", chat_id: "preserve" }, driver_ids: [driver], smart_driver_id: driver, updated_at: "",
  pickup_customer_id: pickup, dropoff_customer_id: destination, alternate_dropoff_customer_id: null,
  shift_start: "22:00:00", shift_end: "06:00:00", review_issues: [] };
const line = asLine({ row: 2, driver: "Driver", start: "22:00", end: "06:00", alt_drop_off_id: alternate });
assert.equal(line.alt_drop_off_id, alternate);
assert.notEqual(sig(line), sig({ ...line, alt_drop_off_id: "" }));
assert.equal(applyCopiedLines([line], [{ driver: "New", start: "22:00", end: "06:00" }], "").lines[0].alt_drop_off_id, "");
for (const bad of ["invalid", 123, null]) assert.throws(() => ruleChange({customer_id:pickup,driver_ids:[driver],dropoff_id:"",shift_start:"",shift_end:"",alt_drop_off_id:bad as string}));
assert.deepEqual(profilePatch("client", {}, { default_dropoff_id: destination, eta_minutes: "20" }, true), { default_dropoff_id: destination, eta_minutes: 20 });

// No live writes: exercise both default-dropoff owners with a strict fetch stub.
const oldFetch = globalThis.fetch;
const testEnv = { SUPABASE_URL: "https://supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "test-only", MASTER_CLIENT_INFO_SOURCE: "supabase", CARTRACK_AUTH: "test-only", LABCENTER_EMAIL: "test-only", LABCENTER_PASSWORD: "test-only" };
const previousEnv = Object.fromEntries(Object.keys(testEnv).map(k => [k, process.env[k]]));
Object.assign(process.env, testEnv);
let linked = false;
let labcenterAccepts = true;
const writes: { url: string; body: Record<string, unknown> }[] = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const json = (data: unknown) => Response.json(data);
  if (url.startsWith("https://supabase.invalid/rest/v1/master_clients")) {
    if (method === "PATCH") { writes.push({ url, body: JSON.parse(String(init?.body)) }); return json([]); }
    assert.equal(method, "GET");
    const id = new URL(url).searchParams.get("customer_id")?.slice(3);
    if (!id) return json([pickup,destination,alternate].map(customer_id=>({customer_id,customer_name:"Location",cartrack:{customer_name:"Location"}})));
    return json([{ customer_id: id, cartrack: { customer_name: "Location" }, default_dropoff_id: null, eta_minutes: null,
      labcenter_location_id: linked ? id === pickup ? 10 : 20 : null }]);
  }
  if (url.includes("/rest/v1/master_config_rules")) return json([{ ...rule, master_rule_drivers: [{driver_id:driver,selection_order:0}] }]);
  if (url.includes("/rest/v1/master_drivers")) return json([{driver_id:driver,first_name:"Driver",last_name:"",cartrack:{first_name:"Driver"},roster:{}}]);
  if (url.endsWith("/rest/v1/rpc/master_write_rules")) { writes.push({url,body:JSON.parse(String(init?.body))}); return json([{id:1,revision:8,source_row:2}]); }
  if (url.includes("fleetapi-vn.cartrack.com") && method === "GET") return json({ data: { customer_name: "Location", latitude: "invalid", longitude: "invalid" } });
  if (url.endsWith("/api/v1/auth/login")) return json({ token: "test-only" });
  if (url.endsWith("/api/locations/update-pick-drop-location")) { writes.push({ url, body: JSON.parse(String(init?.body)) }); return json({}); }
  if (url.includes("/api/pick-drop-locations?")) return json({ data: [{ pick_location_id: 10, drop_location_id: labcenterAccepts ? 20 : 21, estimate_pick_up: 20 }] });
  throw new Error(`Unexpected request: ${method} ${url}`);
};
try {
  await editClient(pickup, { default_dropoff_id: destination });
  assert.deepEqual(writes.map(w => w.body), [{ default_dropoff_id: destination, default_dropoff_name: "Location", eta_minutes: null }]);
  writes.length = 0;
  await editClient(pickup, { default_dropoff_id: "" });
  assert.equal(writes[0].body.default_dropoff_id, null);
  linked = true; writes.length = 0;
  await editClient(pickup, { default_dropoff_id: destination, eta_minutes: 20 });
  assert.deepEqual(writes.map(w => w.body), [{ pick_id: pickup, drop_id: destination, estimate_pick_up: 20 },
    { default_dropoff_id: destination, default_dropoff_name: "Location", eta_minutes: 20 }]);
  labcenterAccepts = false; writes.length = 0;
  await assert.rejects(editClient(pickup, { default_dropoff_id: destination, eta_minutes: 20 }), /không cập nhật/);
  assert.equal(writes.length, 1); // A failed Labcenter read-back must not update Supabase.
  writes.length = 0;
  await assert.rejects(editClient(pickup, { default_dropoff_id: "", eta_minutes: 20 }));
  assert.equal(writes.length, 0);
  const target = {row:2,expectPickup:"Location",expected:{rule_id:1,revision:7,driver:"Driver",start:"22:00",end:"06:00",dropoff:"Location"}};
  await editMasterConfig(target,{alt_drop_off_id:alternate});
  const changes = () => (writes.at(-1)!.body.changes as Record<string,unknown>[])[0];
  assert.deepEqual(changes(), {id:1,revision:7,assignment_mode:"smart",driver_ids:[driver],pickup_customer_id:pickup,dropoff_customer_id:destination,
    alternate_dropoff_customer_id:alternate,shift_start:"22:00",shift_end:"06:00",row_data:{}});
  writes.length=0;
  rule.alternate_dropoff_customer_id=alternate;
  await editMasterConfig(target,{start:"21:00"});
  assert.equal(changes().alternate_dropoff_customer_id,alternate,"Other config edits preserve the alternative");
  await editMasterConfig(target,{alt_drop_off_id:""});
  assert.equal(changes().alternate_dropoff_customer_id,null);
  writes.length=0;
  await assert.rejects(editMasterConfig({...target,expected:{...target.expected,revision:6}},{alt_drop_off_id:alternate}),/tải lại/);
  assert.equal(writes.length,0);
  await createMasterConfigRows([{customer_id:pickup,pickup:"Location",driver_ids:[driver],dropoff:"",start:"22:00",end:"06:00",alt_drop_off_id:alternate}]);
  assert.equal(changes().alternate_dropoff_customer_id,alternate,"New rules save their own alternative");
} finally {
  globalThis.fetch = oldFetch;
  for (const [key, value] of Object.entries(previousEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
console.log("Profile checks passed: GPS lock, secrets, shifts, rule revisions and separate default/alternative ownership");
