import { NextResponse, after } from "next/server";
import { Redis } from "@upstash/redis";
import { vnDate } from "./time";
import { invalidateConfigCache, invalidateDriversCache, loadConfigFromSheets } from "./config";
import { invalidateLeaveCache } from "./leave-config";
import { invalidateShiftCache } from "./shift-window";
import { syncCartrackProfiles, syncLabcenterMetadata } from "./master-sync";

const KEY="sync:morning:v1", LOCK=KEY+":lock", TTL=7*86400, COOLDOWN=15;
type Run={id:number,status:"queued"|"in_progress"|"completed",conclusion:"success"|"failure"|null,
  created_at:string,updated_at:string,daily:boolean,phase:"profiles"|"metadata"|"misa"|"cache",
  cursor:string,months:string[],monthIndex:number,processed:number,issues:number,shiftRows:number,error?:string};
function redis() {
  const url=process.env.KV_REST_API_URL??process.env.UPSTASH_REDIS_REST_URL;
  const token=process.env.KV_REST_API_TOKEN??process.env.UPSTASH_REDIS_REST_TOKEN;
  if(!url||!token)throw new Error("Redis configuration required for sync coordination");
  return new Redis({url,token});
}
function missing() {
  return ["MISA_USERNAME","MISA_PASSWORD","MISA_TOTP_SECRET","SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","CRON_SECRET"].filter(k=>!process.env[k]);
}
export function misaMonths(month:string|null,now=new Date()) {
  if(month) {
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw new Error("Invalid month; use YYYY-MM");
    return [month];
  }
  const [y,m]=vnDate(now).split("-").map(Number);
  return [-2,-1,0,1].map(offset=>new Date(Date.UTC(y,m-1+offset,1)).toISOString().slice(0,7));
}
export function syncWait(run:Run|null,now=Date.now()) {
  if(!run)return {running:false,wait:0};
  return {running:run.status!=="completed" && now-Date.parse(run.updated_at)<335000,
    wait:run.status==="completed" && run.conclusion==="success"?Math.max(0,Math.ceil(COOLDOWN-(now-Date.parse(run.created_at))/60000)):0};
}
async function release(db:Redis,key:string,owner:string) {
  await db.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",[key],[owner]);
}
export async function getMisaSyncStatus() {
  if(missing().length)return NextResponse.json({status:"disabled",missing:missing()});
  const run=await redis().get<Run>(KEY);
  if(!run)return NextResponse.json({status:"unknown",cooldown_minutes:COOLDOWN});
  const stale=run.status!=="completed" && !syncWait(run).running;
  return NextResponse.json({id:run.id,status:stale?"completed":run.status,conclusion:stale?"failure":run.conclusion,
    started:run.created_at,phase:run.phase,month:run.months[run.monthIndex]??null,processed:run.processed,
    issues:run.issues,shift_rows:run.shiftRows,error:stale?"Sync interrupted; retry to resume from current source data":run.error,
    cooldown_minutes:COOLDOWN,cooldown_remaining:syncWait(run).wait});
}
export async function dispatchMisaSync(month:string|null=null,syncMaster=false) {
  if(missing().length)return NextResponse.json({status:"disabled",missing:missing()});
  let months:string[];
  try {months=misaMonths(month);}catch(e){return NextResponse.json({status:"error",error:String(e)},{status:400});}
  const db=redis(),owner=crypto.randomUUID(),startLock=KEY+":start";
  if(await db.set(startLock,owner,{nx:true,ex:30})!=="OK")return NextResponse.json({status:"already_running"});
  try {
    const previous=await db.get<Run>(KEY),{running,wait}=syncWait(previous);
    if(running)return NextResponse.json({status:"already_running",id:previous!.id});
    if(syncMaster && await db.get(KEY+":done:"+vnDate()))return NextResponse.json({status:"already_completed"});
    if(!syncMaster && wait)return NextResponse.json({status:"cooldown",conclusion:previous!.conclusion,cooldown_minutes:COOLDOWN,cooldown_remaining:wait});
    const timestamp=new Date().toISOString();
    const run:Run={id:Date.now(),status:"queued",conclusion:null,created_at:timestamp,updated_at:timestamp,daily:syncMaster,
      phase:syncMaster?"profiles":"misa",cursor:"",months,monthIndex:0,processed:0,issues:0,shiftRows:0};
    await db.set(KEY,run,{ex:TTL});
    after(()=>runMisaSyncStep(run.id));
    return NextResponse.json({status:"dispatched",id:run.id,previous_run_id:previous?.id??null},{status:202});
  }finally{await release(db,startLock,owner);}
}
/** One bounded phase per invocation; checkpoints survive cold starts. No recurring polling job. */
export async function runMisaSyncStep(id:number) {
  const db=redis(),owner=crypto.randomUUID();
  if(await db.set(LOCK,owner,{nx:true,ex:330})!=="OK")return;
  let run:Run|null=null,more=false;
  try {
    run=await db.get<Run>(KEY);
    if(!run||run.id!==id||run.status==="completed")return;
    run.status="in_progress";run.updated_at=new Date().toISOString();await db.set(KEY,run,{ex:TTL});
    if(run.phase==="profiles") {
      await syncCartrackProfiles();invalidateDriversCache();await invalidateConfigCache();run.phase="metadata";
    }else if(run.phase==="metadata") {
      const report=await syncLabcenterMetadata(0,40,undefined,run.cursor);
      run.processed+=report.processed;run.issues+=report.issues.length;
      if(report.nextCursor) {
        if(!/^\d+$/.test(report.nextCursor)||report.nextCursor<=run.cursor)throw new Error("Labcenter cursor did not advance");
        run.cursor=report.nextCursor;
      }else run.phase="misa";
      await invalidateConfigCache();
    }else if(run.phase==="misa") {
      const {runNativeMisa}=await import("./misa-native");
      const result=await runNativeMisa(run.months[run.monthIndex]);
      run.shiftRows+=result?.shiftRows??0;run.monthIndex++;
      await Promise.all([invalidateShiftCache(),invalidateLeaveCache(),invalidateConfigCache()]);
      if(run.monthIndex===run.months.length)run.phase="cache";
    }else {
      invalidateDriversCache();await Promise.all([invalidateConfigCache(),invalidateShiftCache(),invalidateLeaveCache()]);
      if(!await loadConfigFromSheets())throw new Error("Configuration cache refresh failed");
      run.status="completed";run.conclusion="success";
      if(run.daily)await db.set(KEY+":done:"+vnDate(new Date(run.created_at)),"1",{ex:TTL});
    }
    run.updated_at=new Date().toISOString();await db.set(KEY,run,{ex:TTL});more=run.status!=="completed";
  }catch(e) {
    // Restricted credentials never enter status responses or logs.
    let message=e instanceof Error?e.message:"Sync failed";
    for(const key of ["MISA_USERNAME","MISA_PASSWORD","MISA_TOTP_SECRET","SUPABASE_SERVICE_ROLE_KEY","CRON_SECRET"])
      if(process.env[key])message=message.split(process.env[key]!).join("[redacted]");
    console.error("[morning-sync]",message.slice(0,300));
    if(run?.id===id){run.status="completed";run.conclusion="failure";run.error=message.slice(0,300);run.updated_at=new Date().toISOString();await db.set(KEY,run,{ex:TTL});}
  }finally{await release(db,LOCK,owner);}
  if(more) {
    try {
      // Fixed production origin prevents forwarding the secret to caller-controlled hosts.
      const response=await fetch(`https://diag-logistics.vercel.app/api/misa-sync/continue?run=${id}`,{
        method:"POST",headers:{Authorization:`Bearer ${process.env.CRON_SECRET}`},signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error(`Sync continuation HTTP ${response.status}`);
    }catch(e) {
      const latest=await db.get<Run>(KEY);
      if(latest?.id===id && latest.status!=="completed"){latest.status="completed";latest.conclusion="failure";latest.error=e instanceof Error?e.message:"Continuation failed";latest.updated_at=new Date().toISOString();await db.set(KEY,latest,{ex:TTL});}
    }
  }
}
