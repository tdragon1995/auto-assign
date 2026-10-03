import assert from 'node:assert/strict';
import {assertSheetRenameSafe} from '../src/lib/master-profile';
import {getSheetsClient} from '../src/lib/sheets-writer';
import {SHEET_GID} from '../src/lib/sheets';
import {syncLabcenterMetadata, labcenterClientCode} from '../src/lib/master-sync';
import {POST as refresh} from '../src/app/api/master-client-info/sync/route';
import {NextRequest} from 'next/server';

// Strict in-process stubs: no Sheet, Cartrack or Labcenter writes.
Object.assign(process.env,{GOOGLE_SERVICE_ACCOUNT_KEY:'{}',MASTER_CLIENT_INFO_SOURCE:'supabase',
  SUPABASE_URL:'https://supabase.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-only',
  LABCENTER_EMAIL:'test-only',LABCENTER_PASSWORD:'test-only',
  LABCENTER_RECEPTIONIST_EMAIL:'test-only',LABCENTER_RECEPTIONIST_PASSWORD:'test-only'});
const pickup='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const drop='33333333-3333-4333-8333-333333333333';
const sheets=getSheetsClient();
const tabs=[{gid:SHEET_GID.sunday,title:'Sunday'},{gid:SHEET_GID.drivers,title:'Driver'},{gid:SHEET_GID.locations,title:'Location Table'}];
let sundayRows: string[][]=[[pickup,'Old name']];
sheets.spreadsheets.get=(async()=>({data:{sheets:[...tabs.map(t=>({properties:{sheetId:Number(t.gid),title:t.title}})),
  {properties:{sheetId:99,title:'(Edit weekly) PUBLIC SUNDAY SCHEDULE'}}]}})) as unknown as typeof sheets.spreadsheets.get;
sheets.spreadsheets.values.batchGet=(async(params:{ranges:string[]})=>{
  assert.ok(!params.ranges.some(r=>r.includes('PUBLIC SUNDAY'))); // Display-only names are harmless.
  return {data:{valueRanges:[{range:'Sunday!A1:N10',values:sundayRows},
    {range:'Driver!A1:P10',values:[[other,'Driver alias',pickup]]},
    {range:'Location Table!A1:Z10',values:[['Old name',pickup]]}]}};
}) as unknown as typeof sheets.spreadsheets.values.batchGet;
await assertSheetRenameSafe(pickup,['Old name']); // Old aliases and resolved Sunday IDs survive rename.
sundayRows=[['Old name','unresolved']];
await assert.rejects(assertSheetRenameSafe(pickup,['Old name']),/Sunday.*dòng 1/);
sundayRows=[[other,`${other},${pickup}`,'Old name']];
await assertSheetRenameSafe(pickup,['Old name']); // Effective Smart selections use UUID lists.
process.env.MASTER_CLIENT_INFO_SOURCE='sheet';
await assert.rejects(assertSheetRenameSafe(pickup,['Old name']));
process.env.MASTER_CLIENT_INFO_SOURCE='supabase';

let destinationReads=0,existingLink:number|null=null,scenario='linked';
const writes:Record<string,unknown>[][]=[];
const accountWrites:Record<string,unknown>[][]=[];
globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input)),method=init?.method??'GET';
  if(url.hostname==='supabase.invalid') {
    if (url.pathname==='/rest/v1/rpc/master_sync_accounts') {
      assert.equal(method,'POST');accountWrites.push(JSON.parse(String(init?.body)).accounts);
      return new Response(null,{status:204}); // Real PostgREST response for RETURNS void.
    }
    if(url.pathname==='/rest/v1/master_clients' && method==='GET') return Response.json([
      {customer_id:pickup,customer_name:'Client 1',client_code:'1',labcenter_location_id:10},
      {customer_id:other,customer_name:'Client 2',client_code:'2',labcenter_location_id:11},
      {customer_id:drop,client_code:null,labcenter_location_id:existingLink}]);
    assert.equal(method,'POST');assert.equal(url.pathname,'/rest/v1/master_clients');
    writes.push(JSON.parse(String(init?.body)));return new Response(null,{status:204});
  }
  if(url.pathname.endsWith('/auth/login')) return Response.json({token:'test-only'});
  assert.equal(method,'GET');
  if(url.pathname.endsWith('/pick-drop-locations')) {
    const page=Number(url.searchParams.get('page'));
    const rows=Array.from({length:page<3?500:1},(_,i)=>({pick_location_id:i%2?10:11,drop_location_id:20,
      estimate_pick_up:90,drop_location:{name:'BRA - D032'}}));
    if (scenario==='missing_dropoff') for (const row of rows) row.pick_location_id=11;
    if (scenario==='conflicting_dropoff' && rows[1]) rows[1].drop_location_id=21;
    if (scenario==='invalid_eta') for (const row of rows) row.estimate_pick_up=NaN;
    return Response.json({data:rows});
  }
  if(url.pathname.endsWith('/locations')) return Response.json({data:[{id:url.searchParams.get('client_code')==='1'?10:11}]});
  if(url.pathname.endsWith('/locations/20')) {destinationReads++;return Response.json({data:{delivery_integration_locations:[
    {delivery_integration_code:'cartrack_vn',delivery_integration_location_id:scenario==='unresolved'?'unknown':drop}]}});}
  if(url.pathname.endsWith('/client')) return scenario==='sales_failure' ? new Response('',{status:503}) : Response.json({data:scenario==='owners' ? [
    {code:url.searchParams.get('q'),owner_name:'Sales',owner:'sales@example.test',supervisor:'Supervisor',supervisor_email:'sup@example.test'}] : []});
  throw Error(`Unexpected request: ${method} ${url}`);
};
const result=await syncLabcenterMetadata(0,2);
assert.equal(result.matched,2);assert.equal(result.errors,0);assert.equal(destinationReads,1);
const updated=writes.flat();
assert.deepEqual(updated.find(r=>r.customer_id===drop),{customer_id:drop,labcenter_location_id:20});
assert.ok(updated.filter(r=>r.customer_id!==drop).every(r=>r.default_dropoff_id===drop && r.eta_minutes===90));
assert.ok(updated.every(r=>!('cartrack' in r) && !('bot_token' in r)));
assert.equal(result.processed,2);assert.equal(result.nextCursor,null);
assert.ok(result.issues.every(i=>i.kind==='missing_owner' && i.customer_id && i.name));
assert.equal(labcenterClientCode('{inactive} 55025027 - Hospital'),'55025027');
assert.equal(labcenterClientCode('55025027 - Hospital {inacttiv}'),'55025027');
assert.equal(labcenterClientCode('55025027xyz - Hospital'),null);
existingLink=99;writes.length=0;
const oldError=console.error;console.error=()=>{};
try {assert.equal((await syncLabcenterMetadata(0,2)).errors,2);assert.equal(writes.length,0);}
finally {console.error=oldError;}
existingLink=null;
for (const kind of ['missing_dropoff','conflicting_dropoff','unresolved','sales_failure','invalid_eta']) {
  scenario=kind;writes.length=0;
  console.error=()=>{};
  try {
    const report=await syncLabcenterMetadata(0,2);
    assert.ok(report.issues.some(i=>i.kind===(kind==='sales_failure'?'request_failed':kind==='unresolved'?'unresolved_dropoff':kind)));
    if(kind!=='sales_failure') assert.ok(!writes.flat().some(r=>r.customer_id===pickup),'Unresolved rows must retain previous metadata');
    else {assert.equal(report.errors,2);assert.equal(report.matched,2);}
  } finally {console.error=oldError;}
}
scenario='linked';writes.length=0;
const first=await syncLabcenterMetadata(0,1,undefined,'');
assert.equal(first.processed,1);assert.equal(first.nextCursor,'1');
const second=await syncLabcenterMetadata(0,1,undefined,first.nextCursor!);
assert.equal(second.processed,1);assert.equal(second.nextCursor,null);assert.equal(second.issues[0].client_code,'2');
const response=await refresh(new NextRequest('https://dashboard.invalid/api/master-client-info/sync?phase=metadata&limit=1&after=1',{method:'POST'}));
assert.equal(response.status,200);assert.equal((await response.json()).labcenter.issues[0].client_code,'2');
assert.equal((await refresh(new NextRequest('https://dashboard.invalid/api/master-client-info/sync?phase=metadata&limit=201',{method:'POST'}))).status,400);
scenario='owners';writes.length=0;
const withOwners=await syncLabcenterMetadata(0,2);
assert.equal(withOwners.owners,2);assert.equal(withOwners.issues.length,0);assert.equal(accountWrites.flat().length,2);
assert.ok(writes.flat().filter(r=>r.customer_id!==drop).every(r=>r.sales_name==='Sales' && r.default_dropoff_id===drop));
console.log('Profile aliases, verified metadata links, cursor pagination, public manual refresh, preserved unresolved values and case-by-case issue flags passed.');
