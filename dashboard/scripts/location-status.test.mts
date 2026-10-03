import assert from "node:assert/strict";
import { activeLocationRules, hasInactiveStop, isInactiveLocation, locationName } from "../src/lib/location-status";
import { editClient, editDriver } from "../src/lib/master-profile";
import { getSheetsClient } from "../src/lib/sheets-writer";
import { SHEET_GID } from "../src/lib/sheets";
import { profilePatch } from "../src/components/master-profile-editor";
import { writeMasterRules } from "../src/lib/master-store";

const pickup="11111111-1111-4111-8111-111111111111", driver="22222222-2222-4222-8222-222222222222";
assert.equal(locationName("{inactive} Location {inacttiv}",false),"{inactive} Location");
assert.equal(locationName("Location {inacttiv}",true),"Location");
assert.ok(isInactiveLocation("{INACTIVE} Location") && isInactiveLocation("Location {inacttiv}"));
assert.deepEqual(profilePatch("client",{customer_name:"Location"},{is_active:"false"},true),{is_active:false});
assert.deepEqual(profilePatch("client",{customer_name:"Location {inacttiv}"},{is_active:"true"},true),{is_active:true});
assert.throws(()=>profilePatch("client",{},{is_active:"bad"},true));
const rules=[{customer_id:pickup,dropoff_id:"",alt_drop_off_id:""},{customer_id:driver,dropoff_id:pickup},{customer_id:driver,alt_drop_off_id:pickup},{customer_id:driver}];
assert.deepEqual(activeLocationRules(rules,[pickup]),[{},{},{},rules[3]],"pickup, destination and alternative references are excluded without changing row positions");
assert.ok(hasInactiveStop([{customer_id:driver},{customer_id:pickup}],new Set([pickup])),"a wildcard route cannot assign a job at an inactive destination");
assert.ok(!hasInactiveStop([{customer_id:driver}],new Set([pickup])));

// All writes stay in these strict stubs; no real profiles or assignments change.
Object.assign(process.env,{SUPABASE_URL:"https://supabase.invalid",SUPABASE_SERVICE_ROLE_KEY:"test-only",
  MASTER_CLIENT_INFO_SOURCE:"supabase",CARTRACK_AUTH:"test-only",GOOGLE_SERVICE_ACCOUNT_KEY:"{}",LABCENTER_EMAIL:"test@example.invalid",LABCENTER_PASSWORD:"test-only"});
const sheets=getSheetsClient();
sheets.spreadsheets.get=(async()=>({data:{sheets:[SHEET_GID.sunday,SHEET_GID.drivers,SHEET_GID.locations].map(gid=>({properties:{sheetId:Number(gid),title:gid}}))}})) as unknown as typeof sheets.spreadsheets.get;
sheets.spreadsheets.values.batchGet=(async()=>({data:{valueRanges:[{values:[[pickup,"Location"]]},{values:[[driver,"Old Name"]]},{values:[]}]}})) as unknown as typeof sheets.spreadsheets.values.batchGet;
let customer={customer_id:pickup,customer_name:"Location",latitude:10.5,longitude:106.5,address_line_1:"Address",contact_number:"123"};
let cartrackDriver={first_name:"Old",last_name:"Name",phone_number:"123"};
const roster={Driver:"Old Name",employee_code:"unchanged",employee_full_name:"Payroll name",code_name:"internal"};
const writes:{url:string;body:Record<string,unknown>}[]=[];
let inactiveSelection=false;
let linked=false,ignoreStatus=false;
let labcenter={name:"Location",is_active:true,latitude:10.5,longitude:106.5,address:"unchanged"};
const oldFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
  const url=String(input),method=init?.method??"GET";
  if(url.startsWith("https://supabase.invalid/rest/v1/")) {
    if(method==="POST" || method==="PATCH") {writes.push({url,body:JSON.parse(String(init?.body))});return Response.json([]);}
    if(url.includes("master_clients") && url.includes("is_active=eq.false")) return Response.json(inactiveSelection ? [{customer_id:pickup,is_active:false}] : []);
    if(url.includes("master_clients")) return Response.json([{customer_id:pickup,cartrack:customer,labcenter_location_id:linked?2188:null}]);
    if(url.includes("master_drivers")) return Response.json([{driver_id:driver,cartrack:cartrackDriver,roster,bot_token:"preserved",driver_zalo_id:"preserved"}]);
  }
  if(url==="https://api-bknd.labcenter.vn/api/v1/auth/login") return Response.json({token:"test-only"});
  if(url.endsWith("/api/locations/2188")) {
    if(method==="PUT") {
      const body=JSON.parse(String(init?.body));assert.deepEqual(Object.keys(body).sort(),["is_active","name"]);
      labcenter={...labcenter,...body,is_active:ignoreStatus?labcenter.is_active:body.is_active};writes.push({url,body});
    }
    return Response.json({data:labcenter});
  }
  if(url.endsWith(`/customers/${pickup}`)) {
    if(method==="PUT") {const body=JSON.parse(String(init?.body));customer={...customer,...body};writes.push({url,body});}
    return Response.json({data:customer});
  }
  if(url.endsWith(`/drivers/${driver}`)) {
    if(method==="PUT") {const body=JSON.parse(String(init?.body));cartrackDriver={...cartrackDriver,...body};writes.push({url,body});}
    return Response.json({data:cartrackDriver});
  }
  throw new Error(`Unexpected request: ${method} ${url}`);
};
try {
  await editClient(pickup,{is_active:false});
  assert.equal(customer.customer_name,"{inactive} Location");
  assert.equal(customer.latitude,10.5);assert.equal(customer.longitude,106.5);
  assert.equal((writes.at(-1)!.body as unknown as {cartrack:typeof customer}[])[0].cartrack.customer_name,customer.customer_name);
  await editClient(pickup,{customer_name:"New location"});
  assert.equal(customer.customer_name,"{inactive} New location","renaming cannot accidentally reactivate a location");
  await editClient(pickup,{is_active:true});
  assert.equal(customer.customer_name,"New location");
  const count=writes.length;
  await assert.rejects(editClient(pickup,{is_active:"false"}),/Trạng thái/);
  assert.equal(writes.length,count);
  inactiveSelection=true;
  await assert.rejects(writeMasterRules([{pickup_customer_id:pickup}]),/ngừng hoạt động/);
  await assert.rejects(writeMasterRules([{pickup_customer_id:driver,dropoff_customer_id:pickup}]),/ngừng hoạt động/);
  await assert.rejects(writeMasterRules([{pickup_customer_id:driver,alternate_dropoff_customer_id:pickup}]),/ngừng hoạt động/);
  assert.equal(writes.length,count,"inactive reference checks must prevent the rule RPC");
  inactiveSelection=false;
  await editDriver(driver,{last_name:"Renamed",phone_number_update:"456"});
  const saved=(writes.at(-1)!.body as unknown as {driver_id:string;cartrack:typeof cartrackDriver;roster:typeof roster;phone_number_update:string}[])[0];
  assert.equal(saved.driver_id,driver);assert.equal(saved.cartrack.last_name,"Renamed");
  assert.deepEqual(saved.roster,{...roster,Driver:"Old Renamed"});
  assert.equal(saved.phone_number_update,"456");
  assert.ok(!("bot_token" in saved) && !("driver_zalo_id" in saved),"profile upserts leave existing credentials untouched");
  inactiveSelection=false;linked=true;customer.customer_name="Location";
  await editClient(pickup,{is_active:false});
  assert.equal(labcenter.is_active,false);assert.equal(labcenter.name,"{inactive} Location");
  assert.equal(labcenter.latitude,10.5);assert.equal(labcenter.address,"unchanged");
  labcenter.is_active=true;
  const cartrackWrites=writes.filter(w=>w.url.includes("/customers/")).length;
  await editClient(pickup,{is_active:false});
  assert.equal(labcenter.is_active,false,"retry fixes the flag even with an existing Cartrack marker");
  assert.equal(writes.filter(w=>w.url.includes("/customers/")).length,cartrackWrites);
  await editClient(pickup,{is_active:true});assert.equal(labcenter.is_active,true);assert.equal(labcenter.name,"Location");
  ignoreStatus=true;
  await assert.rejects(editClient(pickup,{is_active:false}),/không khớp khi đọc lại/,"a vendor 200 with an ignored flag is not success");
  console.log("Location inactivation/reactivation, GPS preservation, assignment exclusions and linked driver rename checks passed");
} finally {globalThis.fetch=oldFetch;}
