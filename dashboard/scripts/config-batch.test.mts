import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MasterProfileDetails, type ClientMeta } from "../src/components/master-profile-details";
import { saveMasterConfigBatch, bulkMasterConfig } from "../src/lib/master-config-actions";
import { publicClient } from "../src/lib/master-public";
import { NextRequest } from "next/server";
import { POST as bulkUpdate } from "../src/app/api/config/bulk-update/route";

const client: ClientMeta = {customer_id:"11111111-1111-4111-8111-111111111111",cartrack:{customer_name:"Pickup",address_line_1:"Address",address_line_2:"—"},client_code:null,new_ward:null,nearest_psc_name:null,nearest_psc_km:null,default_dropoff_name:null,eta_minutes:0,default_dropoff_id:null,labcenter_location_id:null,sales_name:null,sales_email:"sales@example.test",supervisor_name:null,supervisor_email:null};
const html = renderToStaticMarkup(createElement(MasterProfileDetails,{client,clients:new Map()}));
assert.ok(html.includes("0 phút") && html.includes("sales@example.test") && html.includes("<svg"));
assert.ok(!html.includes("—") && !html.includes("Supervisor") && !html.includes("Phường mới"));
assert.ok(html.includes(client.customer_id) && !html.includes("Ngày tạo (Cartrack)"));
const published=publicClient({...client,nearest_psc_id:null,cartrack:{...client.cartrack,
  create_ts:"2025-11-13 08:26:46",update_ts:"2026-06-24 11:34:28",bot_token:"not-public"}});
assert.equal(published.customer_id,client.customer_id);
assert.equal(published.cartrack.create_ts,"2025-11-13 08:26:46");
assert.equal(published.cartrack.update_ts,"2026-06-24 11:34:28");
assert.ok(!("bot_token" in published.cartrack));
const timestampHtml=renderToStaticMarkup(createElement(MasterProfileDetails,{client:{...client,cartrack:published.cartrack},clients:new Map()}));
assert.ok(timestampHtml.includes("Ngày tạo (Cartrack)") && timestampHtml.includes("2025-11-13 08:26:46")
  && timestampHtml.includes("Cập nhật (Cartrack)") && timestampHtml.includes("2026-06-24 11:34:28"));
assert.ok(!renderToStaticMarkup(createElement(MasterProfileDetails,{driver:{driver_id:"",cartrack:{},roster:{},has_bot_token:false,phone_number_update:null,driver_zalo_id:null},clients:new Map()})).includes("Hoạt động"));

const driverId = "22222222-2222-4222-8222-222222222222";
const rule = {id:1,source_row:2,revision:3,assignment_mode:"smart",pickup_customer_id:client.customer_id,dropoff_customer_id:null,alternate_dropoff_customer_id:null,shift_start:"07:00:00",shift_end:"12:00:00",review_issues:[],row_data:{bot_token:"preserved",chat_id:"preserved"},master_rule_drivers:[{driver_id:driverId,selection_order:0}]};
const expected = {rule_id:1,revision:3,driver:"Driver",start:"07:00",end:"12:00",dropoff:""};
const line = {row:2,expected_row:expected,driver:"Driver",start:"07:00",end:"12:00",dropoff:"",assignment_mode:"smart"};
const previousFetch = globalThis.fetch;
const previousEnv = {SUPABASE_URL:process.env.SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY:process.env.SUPABASE_SERVICE_ROLE_KEY,MASTER_CLIENT_INFO_SOURCE:process.env.MASTER_CLIENT_INFO_SOURCE};
Object.assign(process.env,{SUPABASE_URL:"https://supabase.invalid",SUPABASE_SERVICE_ROLE_KEY:"test",MASTER_CLIENT_INFO_SOURCE:"supabase"});
let reads = 0;
let addPeer = false;
let extraRules: typeof rule[] = [];
const writes: {changes:Record<string,unknown>[]}[] = [];
globalThis.fetch = async (input,init) => {
  const url = String(input);
  if (url.includes("rpc/master_write_rules")) {writes.push(JSON.parse(String(init?.body)));return Response.json([{id:1,source_row:2,revision:4}]);}
  assert.equal(init?.method,"GET"); reads++;
  if (url.includes("master_config_rules")) return Response.json([...extraRules,rule,...(addPeer ? [{...rule,id:2,source_row:3,shift_start:"12:00:00",shift_end:"18:00:00"}] : [])]);
  if (url.includes("master_clients")) return Response.json([{customer_id:client.customer_id,customer_name:"Pickup"}]);
  if (url.includes("master_drivers")) return Response.json([{driver_id:driverId,first_name:"Driver",last_name:"",is_active:true}]);
  throw new Error("Unexpected request");
};
try {
  await saveMasterConfigBatch([{pickup_name:"Pickup",pickup_customer_id:client.customer_id,rows:[{...line,end:"11:00"},{driver:"Driver",start:"11:00",end:"12:00",dropoff:"",assignment_mode:"fixed",copy_from_rule_id:1}],removed:[]}]);
  assert.equal(reads,4);assert.equal(writes.length,1);assert.equal(writes[0].changes.length,2);
  assert.deepEqual(writes[0].changes[0].row_data,{});
  assert.deepEqual(writes[0].changes[1].row_data,{bot_token:"preserved",chat_id:"preserved"});
  assert.equal(writes[0].changes[0].assignment_mode,"smart");
  for (const rows of [[{...line,expected_row:{...expected,revision:2}}],[line,line],[{...line,start:"bad"}],[{...line,driver:"Unknown"}],[line,{driver:"Driver",start:"11:00",end:"13:00",dropoff:""}]]) {
    const count=writes.length;
    await assert.rejects(saveMasterConfigBatch([{pickup_name:"Pickup",rows,removed:[]}]));
    assert.equal(writes.length,count,"invalid batch must not write anything");
  }
  await saveMasterConfigBatch([{pickup_name:"Pickup",rows:[{driver:"Driver",start:"08:00",end:"18:00",dropoff:"",assignment_mode:"fixed"}],removed:[{row:2,expected_row:expected}]}]);
  assert.equal(writes.at(-1)?.changes[1].active,false);
  await bulkMasterConfig([{row:2,expectPickup:"Pickup",expected}],{driverName:"Driver",start:"08:00",end:"18:00"});
  assert.equal(writes.at(-1)?.changes[0].shift_start,"08:00");
  assert.equal(writes.at(-1)?.changes[0].assignment_mode,"smart");
  const rows=[{row:2,pickup_name:"Pickup",expected_row:expected}];
  const request=(body:Record<string,unknown>)=>new NextRequest("https://dashboard.invalid/api/config/bulk-update",{method:"POST",body:JSON.stringify({rows,...body})});
  assert.equal((await bulkUpdate(request({shift_start:"",shift_end:"20:00"}))).status,200);
  assert.equal(writes.at(-1)?.changes[0].shift_start,"07:00","end-only API update keeps the existing start");
  assert.equal(writes.at(-1)?.changes[0].shift_end,"20:00");
  await bulkMasterConfig([{row:2,expectPickup:"Pickup",expected}],{start:"08:00"});
  assert.equal(writes.at(-1)?.changes[0].shift_end,"12:00","start-only update keeps the existing end");
  const beforeInvalid=writes.length;
  for(const body of [{},{shift_end:"29:00"},{shift_end:2000},{shift_start:"20:00",shift_end:"20:00"}]) {
    assert.equal((await bulkUpdate(request(body))).status,400);
  }
  assert.equal(writes.length,beforeInvalid);
  extraRules=[{...rule,id:3,source_row:4,pickup_customer_id:driverId,shift_start:"16:45:00"}];
  await bulkMasterConfig([{row:2,expectPickup:"Pickup",expected},{row:4,expectPickup:"Other",expected:{...expected,rule_id:3,start:"16:45"}}],{end:"20:00"});
  assert.deepEqual(writes.at(-1)?.changes.map(c=>[c.shift_start,c.shift_end]),[["07:00","20:00"],["16:45","20:00"]]);
  extraRules=[];
  const stale=await bulkMasterConfig([{row:2,expectPickup:"Pickup",expected:{...expected,revision:2}}],{end:"20:00"});
  assert.equal(stale.done.length,0);assert.equal(stale.skipped.length,1);
  rule.shift_start="";rule.shift_end="";
  const allDay=await bulkMasterConfig([{row:2,expectPickup:"Pickup",expected}],{end:"20:00"});
  assert.equal(allDay.done.length,0,"an all-day row must not become a half-specified shift");
  assert.equal(allDay.skipped.length,1);
  rule.shift_start="07:00:00";rule.shift_end="12:00:00";
  addPeer=true;
  const count=writes.length;
  await assert.rejects(bulkMasterConfig([{row:2,expectPickup:"Pickup",expected}],{driverName:"Driver",start:"08:00",end:"13:00"}),/trùng giờ/);
  assert.equal(writes.length,count,"overlap with unselected shifts must reject the write");
  await assert.rejects(bulkMasterConfig([{row:2,expectPickup:"Pickup",expected}],{end:"13:00"}),/trùng giờ/);
  assert.equal(writes.length,count,"end-only edits must check overlap with unselected shifts too");
  await assert.rejects(saveMasterConfigBatch([{pickup_name:"Pickup",pickup_customer_id:driverId,rows:[line],removed:[]}]),/Điểm lấy đã thay đổi/);
  console.log("Config batch, hover metadata, stale/invalid rejection and credential preservation checks passed");
} finally {
  globalThis.fetch=previousFetch;
  for(const [key,value] of Object.entries(previousEnv)) if(value===undefined) delete process.env[key];else process.env[key]=value;
}
