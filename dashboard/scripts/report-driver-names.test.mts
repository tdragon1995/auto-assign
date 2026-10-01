// Run: npx tsx scripts/report-driver-names.test.mts
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET as payTeam } from "../src/app/api/pay/team/route";
import { GET as tatTeam } from "../src/app/api/tat/team/route";
import { GET as payMe } from "../src/app/api/pay/me/route";
import { GET as tatMe } from "../src/app/api/tat/me/route";
import { masterDriverNames } from "../src/lib/master-store";
import { NV_COOKIE, signSession } from "../src/lib/driver-session";

const driver="22222222-2222-4222-8222-222222222222", orphan="33333333-3333-4333-8333-333333333333";
const oldName="PT100001 Old Name", orphanName="PT100002 Historical Name", date="2026-09-20";
Object.assign(process.env,{SUPABASE_URL:"https://supabase.invalid",SUPABASE_SERVICE_ROLE_KEY:"test-only",DRIVER_SESSION_SECRET:"test-only"});
let name="Old Name", reads=0;
const jobs=[driver,orphan].map((id,i)=>({driver_id:id,driver_name:i?orphanName:oldName,job_id:i+1,trip_date:date,distance_km:5}));
const daily=jobs.map(j=>({...j,jobs_total:1,jobs_priced:1,total_km:5}));
const punches=["08:00","10:00"].map((t,i)=>({driver_id:driver,driver_name:oldName,job_id:10+i,trip_date:date,kind:i?"out":"in",completed_ts:`${date}T${t}:00+07:00`}));
const tat=jobs.map(j=>({...j,trips_total:1,trips_measured:1,trips_graded:1,trips_on_time:1,long_gaps:0,total_tat_mins:10,total_km:5}));
const oldFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
  assert.equal(init?.method,"GET","report lookup must never write or rearchive");
  const url=new URL(String(input)),table=url.pathname.split("/").at(-1);
  if(table==="master_drivers") {
    reads++;
    assert.equal(url.searchParams.get("select"),"driver_id,first_name,last_name","no credentials or private payloads");
    assert.ok(url.searchParams.get("driver_id")?.includes(driver));
    return Response.json([{driver_id:driver,first_name:"",last_name:name}]);
  }
  const own=url.searchParams.get("driver_id")===`eq.${driver}`;
  switch(table) {
    case "pay_jobs":return Response.json(own?jobs.slice(0,1):jobs);
    case "v_pay_daily":return Response.json(own?daily.slice(0,1):daily);
    case "pay_punches":return Response.json(punches);
    case "pay_days":return Response.json([{trip_date:date}]);
    case "v_tat_daily":return Response.json(own?tat.slice(0,1):tat);
    case "tat_legs":return Response.json([{seq:1,tat_mins:10,on_time:true,distance_km:5,long_gap:false,archived_at:"2026-09-21T00:00:00Z"}]);
    default:throw new Error(`Unexpected request: ${url}`);
  }
};
const cookie=`${NV_COOKIE}=${signSession(driver,oldName)}`;
const request=(path:string)=>new NextRequest(`https://dashboard.invalid${path}`,{headers:{cookie}});
const endpoints=[
  [payTeam,"/api/pay/team?month=2026-10"],
  [payTeam,"/api/pay/team?month=2026-10&detail=1"],
  [tatTeam,"/api/tat/team?month=2026-09"],
  [payMe,"/api/pay/me?month=2026-10"],
  [tatMe,"/api/tat/me"],
] as const;
try {
  assert.equal((await masterDriverNames([])).size,0);assert.equal(reads,0);
  await assert.rejects(masterDriverNames(["bad"]),/Invalid driver ID/);assert.equal(reads,0);
  await masterDriverNames([driver,driver]);assert.equal(reads,1);
  for(const [handler,path] of endpoints) {
    name="Old Name";
    const before=await (await handler(request(path))).json();assert.equal(before.ok,true);
    // Even changing the code in the DISPLAY label cannot reclassify archived pay.
    name="DC100001 Renamed Driver";
    const after=await (await handler(request(path))).json();assert.equal(after.ok,true);
    if(after.driver_name) assert.equal(after.driver_name,name);
    for(const rows of [after.drivers,after.jobs]) if(rows) {
      assert.equal(rows.find((r:{driver_id:string})=>r.driver_id===driver).driver_name,name);
      assert.equal(rows.find((r:{driver_id:string})=>r.driver_id===orphan).driver_name,orphanName);
    }
    const withoutNames=(value:unknown)=>JSON.parse(JSON.stringify(value, (key,v)=>key==="driver_name"?undefined:v));
    assert.deepEqual(withoutNames(after),withoutNames(before),`${path}: pay, TAT, eligibility and IDs stay unchanged`);
  }
  assert.equal(jobs[0].driver_name,oldName);assert.equal(punches[0].driver_name,oldName);
  console.log("Current driver lookups, historical fallback, signed sessions and unchanged pay/TAT checks passed");
} finally {globalThis.fetch=oldFetch;}
