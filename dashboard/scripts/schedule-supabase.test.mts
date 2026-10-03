// Run: npx tsx scripts/schedule-supabase.test.mts — strict fake network, no live jobs.
import assert from "node:assert/strict";
import {NextRequest} from "next/server";
import {GET as options} from "../src/app/api/schedule-job/locations/route";
import {POST,PUT,DELETE} from "../src/app/api/schedule-job/row/route";
import {loadScheduleJobRows,loadSchedulePreassignments,filterRowsForToday,buildReferenceNumber} from "../src/lib/schedule-job";

const pickup="11111111-1111-4111-8111-111111111111",dropoff="22222222-2222-4222-8222-222222222222",driver="33333333-3333-4333-8333-333333333333";
Object.assign(process.env,{MASTER_CLIENT_INFO_SOURCE:"supabase",MASTER_SCHEDULE_SOURCE:"supabase",SUPABASE_URL:"https://supabase.invalid",SUPABASE_SERVICE_ROLE_KEY:"test-only",KV_REST_API_URL:"https://cache.invalid",KV_REST_API_TOKEN:"test-only"});
const cache=new Map<string,string>([["config:gen","generation-1"]]);
let reads=0,name="New client",inactive=false;
let stored={id:1,source_row:2,revision:1,pickup_id:pickup,dropoff_id:dropoff,driver_id:driver as string|null,
  delivery_window:"10:00:00",sent_to_driver_before:60,reference:"Unchanged ref",days:[false,true,true,true,true,true,true],
  pickup:{customer_name:"Current pickup"},dropoff:{customer_name:"Current dropoff"},driver:{first_name:"Current",last_name:"driver"} as {first_name:string;last_name:string}|null,active:true};
const oldFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input)),method=init?.method??"GET";
  if(url.hostname==="cache.invalid") {
    const body=JSON.parse(String(init?.body));
    const execute=([command,key,value]:string[])=>{
      if(command.toUpperCase()==="GET") return cache.get(key)??null;
      if(command.toUpperCase()==="SET") {cache.set(key,value);return "OK";}
      throw new Error(`Unexpected Redis command ${command}`);
    };
    const batched=Array.isArray(body[0]);
    const encode=(v:unknown)=>typeof v==="string"&&v!=="OK"?Buffer.from(v).toString("base64"):v;
    const results=(batched?body:[body]).map((args:string[])=>({result:encode(execute(args))}));
    return Response.json(batched?results:results[0]);
  }
  assert.equal(url.hostname,"supabase.invalid","Master schedule operations must never fetch Sheet or call Cartrack");
  if(url.pathname.endsWith("/master_clients")) {
    reads++;
    return Response.json([{customer_id:pickup,customer_name:name,is_active:!inactive},{customer_id:dropoff,customer_name:"Dropoff",is_active:true}]);
  }
  if(url.pathname.endsWith("/master_drivers")) {reads++;return Response.json([{driver_id:driver,first_name:"New",last_name:"driver",is_active:true}]);}
  if(url.pathname.endsWith("/master_schedule_jobs")) return Response.json(stored.active?[stored]:[]);
  if(url.pathname.endsWith("/rpc/master_write_schedule")) {
    assert.equal(method,"POST");const {item}=JSON.parse(String(init?.body));
    if(item.id && item.revision!==stored.revision) return new Response("stale revision",{status:409});
    if(item.active===false) stored={...stored,active:false,revision:stored.revision+1};
    else stored={...stored,...item,id:1,revision:stored.revision+1,driver_id:item.driver_id||null,driver:item.driver_id?{first_name:"New",last_name:"driver"}:null};
    return Response.json({id:stored.id,revision:stored.revision,row:stored.source_row});
  }
  throw new Error(`Unexpected request ${url}`);
};
const body={pickup_id:pickup,pickup_name:"Untrusted",dropoff_id:dropoff,dropoff_name:"Untrusted",driver_id:driver,
  delivery_window:"10:00",reference:"Unchanged ref",sent_to_driver_before:0,days:[false,true,true,true,true,true,true]};
const req=(method:string,data:object)=>new NextRequest("https://dashboard.invalid/api/schedule-job/row",{method,body:JSON.stringify(data)});
try {
  let choices=await (await options()).json();assert.equal(choices.locations[0].name,"New client");const firstReads=reads;
  await options();assert.equal(reads,firstReads,"Warm option reads must use cache");
  name="Renamed client";cache.set("config:gen","generation-2");choices=await (await options()).json();assert.equal(choices.locations[0].name,name);
  const afterRename=reads;
  cache.set("config:gen","generation-3");cache.set("master:choices:v1",JSON.stringify({gen:"generation-3",at:Date.now(),locations:[{id:pickup,name:"Shared cache name"}],drivers:[]}));
  choices=await (await options()).json();assert.equal(choices.locations[0].name,"Shared cache name");assert.equal(reads,afterRename,"Cold reader reuses shared payload");
  let rows=await loadScheduleJobRows();assert.equal(rows[0].schedule_id,1);assert.equal(rows[0].driver_name,"Current driver");
  assert.equal(filterRowsForToday(rows,0).length,0);assert.equal(filterRowsForToday(rows,1).length,1);
  assert.equal(buildReferenceNumber(rows[0],"2026-10-03"),"Unchanged ref_2026-10-03");
  let saved=await (await POST(req("POST",body))).json();assert.equal(saved.ok,true);assert.equal(saved.id,1);assert.equal(stored.sent_to_driver_before,0);
  assert.equal((await loadSchedulePreassignments()).get(body.reference)?.driver_id,driver);
  const current=stored.revision;
  saved=await (await PUT(req("PUT",{...body,schedule_id:1,revision:current,driver_id:""}))).json();assert.equal(saved.ok,true);
  assert.equal((await loadSchedulePreassignments()).size,0,"Cleared pre-assignment must stay cleared");
  assert.equal((await PUT(req("PUT",{...body,schedule_id:1,revision:current}))).status,500);
  assert.equal((await PUT(req("PUT",body))).status,400,"Legacy row number cannot target a Master record");
  inactive=true;assert.equal((await POST(req("POST",body))).status,400);inactive=false;
  saved=await (await DELETE(req("DELETE",{schedule_id:1,revision:stored.revision}))).json();assert.equal(saved.ok,true);
  rows=await loadScheduleJobRows();assert.equal(rows.length,0);
  console.log("Master schedule CRUD, stable IDs/revisions, pre-assignment parity, inactive rejection and generation-aware L1/L2 choice caches passed");
} finally {globalThis.fetch=oldFetch;}
