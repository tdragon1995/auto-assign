import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/config/replace-driver/route";

const fromId="22222222-2222-4222-8222-222222222222", toId="33333333-3333-4333-8333-333333333333";
const peerId="44444444-4444-4444-8444-444444444444", pickup="11111111-1111-4111-8111-111111111111";
const rule={id:1,source_row:2,revision:3,assignment_mode:"smart",pickup_customer_id:pickup,
  dropoff_customer_id:pickup,alternate_dropoff_customer_id:pickup,shift_start:"07:00:00",shift_end:"12:00:00",
  review_issues:[],row_data:{bot_token:"preserved",chat_id:"preserved"},
  master_rule_drivers:[{driver_id:fromId,selection_order:0},{driver_id:peerId,selection_order:1}]};
const drivers=[
  {driver_id:fromId,first_name:"Renamed source",last_name:"",is_active:false},
  {driver_id:toId,first_name:"Nguyễn",last_name:"Trần Toán",is_active:true},
  {driver_id:peerId,first_name:"Nguyễn",last_name:"Trần Toán",is_active:true},
];
const testEnv={SUPABASE_URL:"https://supabase.invalid",SUPABASE_SERVICE_ROLE_KEY:"test",MASTER_CLIENT_INFO_SOURCE:"supabase",
  CARTRACK_AUTH:"Basic test",KV_REST_API_URL:"",KV_REST_API_TOKEN:"",UPSTASH_REDIS_REST_URL:"",UPSTASH_REDIS_REST_TOKEN:""};
const previousEnv=Object.fromEntries(Object.keys(testEnv).map(k=>[k,process.env[k]])), previousFetch=globalThis.fetch;
Object.assign(process.env,testEnv);
let cartrackActive=true;
const writes:{changes:Record<string,unknown>[]}[]=[];
globalThis.fetch=async (input,init)=>{
  const url=String(input);
  if(url.includes("fleetapi-vn.cartrack.com/rest/delivery/drivers?")) return Response.json({data:Array.from({length:100},(_,i)=>({
    delivery_driver_id:i===0?toId:peerId,first_name:"P - C - PTBU",last_name:"Nguyễn Trần Toán",is_active:i===0?cartrackActive:true,
  }))});
  if(url.includes("rpc/master_write_rules")) { writes.push(JSON.parse(String(init?.body))); return Response.json([{id:1,source_row:2,revision:4}]); }
  assert.equal(init?.method,"GET","The test must never write Cartrack or Sheets");
  if(url.includes("master_rules_read")) return Response.json([rule]);
  if(url.includes("master_clients")) return Response.json([{customer_id:pickup,customer_name:"Pickup",is_active:true}]);
  if(url.includes("master_drivers")) {
    const id=new URL(url).searchParams.get("driver_id")?.replace(/^eq\./,"");
    return Response.json(id?drivers.filter(d=>d.driver_id===id):drivers);
  }
  throw new Error(`Unexpected request ${url}`);
};
const body={from:"Old source name",to:"Nguyễn Trần Toàn",from_driver_id:fromId,to_driver_id:toId,config_day:"weekday",
  rows:[{row:2,pickup_name:"Pickup",expected_row:{rule_id:1,revision:3,driver:"Old source name, Peer",start:"07:00",end:"12:00",dropoff:"Pickup"}}]};
const request=(patch:Record<string,unknown>={})=>new NextRequest("https://dashboard.invalid/api/config/replace-driver",{method:"POST",body:JSON.stringify({...body,...patch})});
try {
  const response=await POST(request());
  assert.equal(response.status,200);
  assert.equal((await response.json()).replaced.length,1,"Renamed / prefixed / duplicate names must not block a selected ID");
  let saved=writes.at(-1)!.changes[0];
  assert.deepEqual(saved.driver_ids,[toId,peerId]);
  assert.equal(saved.assignment_mode,"smart");
  assert.equal(saved.shift_start,"07:00");assert.equal(saved.shift_end,"12:00");
  assert.equal(saved.dropoff_customer_id,pickup);assert.equal(saved.alternate_dropoff_customer_id,pickup);
  assert.deepEqual(saved.row_data,{},"Credential fields remain untouched");

  rule.master_rule_drivers=[{driver_id:fromId,selection_order:0},{driver_id:toId,selection_order:1},{driver_id:peerId,selection_order:2}];
  assert.equal((await POST(request())).status,200);
  assert.deepEqual(writes.at(-1)!.changes[0].driver_ids,[toId,peerId],"Keep other smart drivers and deduplicate replacement");
  rule.assignment_mode="fixed";rule.master_rule_drivers=[{driver_id:fromId,selection_order:0}];
  assert.equal((await POST(request())).status,200);
  saved=writes.at(-1)!.changes[0];assert.deepEqual(saved.driver_ids,[toId]);assert.equal(saved.assignment_mode,"fixed");

  const count=writes.length;
  for(const patch of [{to_driver_id:"bad"},{to_driver_id:fromId},{from_driver_id:null},{from:123}]) assert.equal((await POST(request(patch))).status,400);
  const stale=await POST(request({rows:[{...body.rows[0],expected_row:{...body.rows[0].expected_row,revision:2}}]}));
  assert.equal(stale.status,200);assert.equal((await stale.json()).skipped.length,1);
  cartrackActive=false;assert.equal((await POST(request())).status,400);cartrackActive=true;
  drivers[1].is_active=false;assert.equal((await POST(request())).status,409);drivers[1].is_active=true;
  assert.equal((await POST(request({from_driver_id:"55555555-5555-4555-8555-555555555555"}))).status,409);
  assert.equal(writes.length,count,"Invalid IDs, inactive targets and stale edits must not write");
  console.log("ID-based driver replacement: renamed profiles, fixed/smart preservation and rejected edits passed");
} finally {
  globalThis.fetch=previousFetch;
  for(const [key,value] of Object.entries(previousEnv)) if(value===undefined) delete process.env[key];else process.env[key]=value;
}
