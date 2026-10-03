// Run: npx tsx scripts/schedule-master-options.test.mts — all requests are stubbed.
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET as options } from "../src/app/api/schedule-job/locations/route";
import { POST, PUT } from "../src/app/api/schedule-job/row/route";
import { getSheetsClient, updateScheduleRow } from "../src/lib/sheets-writer";
import { loadScheduleJobRows, loadSchedulePreassignments } from "../src/lib/schedule-job";
import { SHEET_GID } from "../src/lib/sheets";

const pickup="11111111-1111-4111-8111-111111111111",dropoff="22222222-2222-4222-8222-222222222222",driver="33333333-3333-4333-8333-333333333333";
Object.assign(process.env,{MASTER_CLIENT_INFO_SOURCE:"supabase",MASTER_SCHEDULE_SOURCE:"sheet",SUPABASE_URL:"https://supabase.invalid",SUPABASE_SERVICE_ROLE_KEY:"test-only",GOOGLE_SERVICE_ACCOUNT_KEY:"{}"});
const header=["pickup_id","pickup","dropoff_id","dropoff","delivery_windows","reference","sent_to_driver_before","sunday","monday","tuesday","wednesday","thursday","friday","saturday","Driver","driver_id"];
const grid:string[][]=[header,[pickup,"Old pickup",dropoff,"Old dropoff","09:00","Old reference","60","false","true","true","true","true","true","true","Old driver",driver]];
const formulas=grid.map(row=>[...row]);
for(const c of [0,2,15]) formulas[1][c]="=XLOOKUP(old_name,old_table,old_ids)";
const sheets=getSheetsClient();
const writes:{range:string;values:unknown[][]}[]=[];
sheets.spreadsheets.get=(async()=>({data:{sheets:[{properties:{sheetId:Number(SHEET_GID.schedule_job),title:"Scheduled Setup",gridProperties:{rowCount:100,columnCount:30}}}]}})) as unknown as typeof sheets.spreadsheets.get;
sheets.spreadsheets.values.get=(async({range,valueRenderOption}:{range:string;valueRenderOption?:string})=>{
  const data=valueRenderOption==="FORMULA"?formulas:grid;
  const row=/!(\d+):\d+$/.exec(range);
  return {data:{values:row?[data[Number(row[1])-1]??[]]:data}};
}) as unknown as typeof sheets.spreadsheets.values.get;
const col=(letters:string)=>[...letters].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
sheets.spreadsheets.values.update=(async({range,requestBody}:{range:string;requestBody:{values:string[][]}})=>{
  const at=/!([A-Z]+)1$/.exec(range)!;
  grid[0].splice(col(at[1]),0,...requestBody.values[0]);formulas[0]=[...grid[0]];
  return {data:{}};
}) as unknown as typeof sheets.spreadsheets.values.update;
sheets.spreadsheets.batchUpdate=(async({requestBody}:{requestBody:{requests:{copyPaste:{source:{startRowIndex:number;startColumnIndex:number};destination:{startRowIndex:number}}}[]}})=>{
  for(const {copyPaste:p} of requestBody.requests) {
    const r=p.destination.startRowIndex,c=p.source.startColumnIndex;
    formulas[r]??=[];grid[r]??=[];
    formulas[r][c]=formulas[p.source.startRowIndex][c];grid[r][c]="#N/A";
  }
  return {data:{}};
}) as unknown as typeof sheets.spreadsheets.batchUpdate;
sheets.spreadsheets.values.batchUpdate=(async({requestBody}:{requestBody:{data:{range:string;values:unknown[][]}[]}})=>{
  for(const item of requestBody.data) {
    writes.push(item);
    const cell=/!([A-Z]+)(\d+)$/.exec(item.range)!,r=Number(cell[2])-1,c=col(cell[1]);
    grid[r]??=[];grid[r][c]=String(item.values[0][0]);
    if(!formulas[r]?.[c]?.startsWith("=")) {formulas[r]??=[];formulas[r][c]=grid[r][c];}
  }
  return {data:{}};
}) as unknown as typeof sheets.spreadsheets.values.batchUpdate;
const previousFetch=globalThis.fetch;
let inactive=false,inactiveDriver=false;
globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));
  assert.ok(!init?.method||init.method==="GET","no Cartrack job creation or live writes");
  if(url.pathname.endsWith("/master_clients")) return Response.json([
    {customer_id:pickup,customer_name:"New pickup",is_active:!inactive},
    {customer_id:dropoff,customer_name:"New dropoff",is_active:true}]);
  if(url.pathname.endsWith("/master_drivers")) return Response.json([{driver_id:driver,first_name:"New",last_name:"driver",is_active:!inactiveDriver}]);
  if(url.hostname==="docs.google.com") {
    if(url.searchParams.get("gid")===SHEET_GID.locations) return new Response(`customer_id,customer_name\n${dropoff},Old dropoff`);
    if(url.searchParams.get("gid")===SHEET_GID.schedule_job) return new Response(grid.map(row=>Array.from({length:header.length},(_,c)=>JSON.stringify(row[c]??"")).join(",")).join("\n"));
  }
  throw new Error(`Unexpected request: ${url}`);
};
const body={pickup_id:pickup,pickup_name:"Untrusted name",dropoff_id:dropoff,dropoff_name:"Untrusted name",driver_id:driver,delivery_window:"10:00",reference:"New reference",sent_to_driver_before:60,days:[false,true,true,true,true,true,true]};
const req=(method:string,data:object)=>new NextRequest("https://dashboard.invalid/api/schedule-job/row",{method,body:JSON.stringify(data)});
try {
  const list=await (await options()).json();assert.equal(list.source,"supabase");
  assert.equal(list.locations[0].id,pickup);assert.equal(list.drivers[0].name,"New driver");
  const added=await (await POST(req("POST",body))).json();assert.equal(added.ok,true);assert.equal(added.warning,null);
  assert.deepEqual(header.slice(-3),["master_pickup_id","master_dropoff_id","master_driver_id"]);
  assert.ok(!writes.some(w=>/!(A|C|P)3$/.test(w.range)),"legacy ID formulas must remain untouched");
  let row=(await loadScheduleJobRows())[1];assert.equal(row.pickup_id,pickup);assert.equal(row.dropoff_id,dropoff);assert.equal(row.driver_id,driver);
  assert.equal(row.pickup_name,"New pickup");assert.equal(row.driver_name,"New driver");
  assert.equal((await loadSchedulePreassignments()).get(body.reference)?.driver_id,driver);
  grid[2][15]="old-stale-driver";formulas[2][15]="=XLOOKUP(old_name,old_table,old_ids)";
  const edited=await (await PUT(req("PUT",{...body,rowIndex:added.row,original:{reference:body.reference,pickup_id:pickup},driver_id:""}))).json();assert.equal(edited.ok,true);
  row=(await loadScheduleJobRows())[1];assert.equal(row.driver_id,"");assert.equal((await loadSchedulePreassignments()).size,1,"clearing a Master driver must ignore the stale formula");
  const before=writes.length;inactive=true;
  assert.equal((await POST(req("POST",{...body,reference:"Inactive"}))).status,400);assert.equal(writes.length,before);inactive=false;
  inactiveDriver=true;
  assert.equal((await POST(req("POST",{...body,reference:"Inactive driver"}))).status,400);assert.equal(writes.length,before);inactiveDriver=false;
  assert.equal((await POST(req("POST",{...body,pickup_id:"bad"}))).status,400);assert.equal(writes.length,before);
  process.env.MASTER_CLIENT_INFO_SOURCE="sheet";
  assert.equal((await (await options()).json()).source,"sheet");
  grid[2][0]=pickup;grid[2][2]=dropoff;
  await updateScheduleRow({rowIndex:3,reference:body.reference,pickup_id:pickup},{pickup_id:pickup,pickup:"New pickup",dropoff_id:dropoff,dropoff:"New dropoff",driver:"",driver_id:"",delivery_windows:"10:00",reference:body.reference,sent_to_driver_before:60,days:body.days});
  assert.equal(grid[2][header.indexOf("master_pickup_id")],"","Sheet edits cannot leave stale Master overrides");
  console.log("Fresh Master client/driver choices, stable schedule IDs, formula preservation, clear-driver and legacy-mode checks passed");
} finally {globalThis.fetch=previousFetch;}
