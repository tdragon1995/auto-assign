import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET } from "../src/app/api/psc-tinh/route";
const keys=["MASTER_CLIENT_INFO_SOURCE","SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","KV_REST_API_URL","KV_REST_API_TOKEN","UPSTASH_REDIS_REST_URL","UPSTASH_REDIS_REST_TOKEN"];
const previous=keys.map(k=>process.env[k]), savedFetch=globalThis.fetch, savedError=console.error;
for(const key of keys)delete process.env[key];
Object.assign(process.env,{MASTER_CLIENT_INFO_SOURCE:"supabase",SUPABASE_URL:"https://supabase.invalid",SUPABASE_SERVICE_ROLE_KEY:"test"});
let reads=0,fail=false,entries=[{psc_tinh:"D021",tpl_name:"3PL destination",tpl_uuid:"11111111-1111-4111-8111-111111111111",address:"Test address"}];
globalThis.fetch=async(input,init)=>{
 const url=new URL(String(input));assert.equal(url.origin,"https://supabase.invalid");assert.equal(init?.method??"GET","GET");
 assert.equal(url.pathname,"/rest/v1/master_tpl_entries");assert.equal(url.searchParams.get("active"),"eq.true");reads++;
 return fail ? new Response("unavailable",{status:503}) : Response.json(entries);
};
const request=(fresh=false)=>GET(new NextRequest("https://dashboard.invalid/api/psc-tinh?mode=mappings"+(fresh?"&fresh=1":"")));
try {
 const first=await request(true);assert.equal(first.status,200);assert.deepEqual((await first.json()).entries,entries);assert.equal(first.headers.get("cache-control"),"private, no-store");
 await request();assert.equal(reads,1,"ordinary reads reuse the existing cache");
 entries=[{...entries[0],address:"Updated address"}];assert.deepEqual((await (await request(true)).json()).entries,entries);assert.equal(reads,2);
 console.error=()=>{};fail=true;const failed=await request(true);assert.equal(failed.status,502);assert.match((await failed.json()).error,/Tải lại/);
 fail=false;assert.equal((await request(true)).status,200);
 assert.equal((await GET(new NextRequest("https://dashboard.invalid/api/psc-tinh"))).status,400);
 console.log("3PL mapping reads, fresh reload, failure recovery passed; no live writes.");
} finally {globalThis.fetch=savedFetch;console.error=savedError;keys.forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});}
