import type { Redis } from "@upstash/redis";
import { sharedRedis } from "./redis";
import { vnDate, vnMinutesSinceMidnight } from "./time";
import { SELF_URL } from "./self-url";

/** Here rather than in misa-sync.ts so the cron route and /api/morning-issues can read the
 * run without bundling the whole sync. */
export const MORNING_RUN_KEY="sync:morning:v1", MORNING_RUN_LOCK=MORNING_RUN_KEY+":lock";
/**
 * Vercel refuses a deployment's calls to itself once one request chain grows too long
 * (508 INFINITE_LOOP_DETECTED). It links the hops itself — our fetch sends nothing but
 * the secret — so code cannot start a fresh chain. On 2026-10-19 cron → /api/morning-sync
 * → three /continue calls passed and the 4th /continue was refused: 4 self-calls ok, the
 * 5th not. Each chain is held to 2 and the next cron-job.org ping, a NEW chain from
 * outside, carries on (resumeMorningSync).
 */
export const MAX_SELF_CALLS=2;
type RunHead={id:number,status:string,daily:boolean,conclusion?:string|null,phase?:string,error?:string,updated_at?:string,months?:string[],monthIndex?:number};

export function morningSyncDue(now=new Date()) { return vnMinutesSinceMidnight(now)>=300 && vnMinutesSinceMidnight(now)<360; }
/** Pings that may resume a paused morning run: 05:00–08:00 VN, so the Redis read costs nothing the rest of the day. */
export function morningResumeDue(now=new Date()) { return vnMinutesSinceMidnight(now)>=300 && vnMinutesSinceMidnight(now)<480; }
export function shouldResume(run:RunHead|null,locked:boolean,now=new Date()) {
  return !!run && run.daily && run.status!=="completed" && !locked && vnDate(new Date(run.id))===vnDate(now);
}
/** What the dashboard says about the latest run: failed, or stopped moving (same 335s as syncWait). */
export function morningRunFailure(run:RunHead|null,now=Date.now()) {
  if(!run)return null;
  const stale=run.status!=="completed" && !!run.updated_at && now-Date.parse(run.updated_at)>=335000;
  if(run.conclusion!=="failure" && !stale)return null;
  // misaDone from the run itself, not the phase: runs before 2026-10-25 did Labcenter first.
  return {at:new Date(run.id).toISOString(),daily:run.daily,phase:run.phase??null,misaDone:!!run.months?.length && (run.monthIndex??0)>=run.months.length,
    error:stale?"Sync interrupted":run.error??"Sync failed"};
}

function continueUrl(id:number,hop:number) { return `${SELF_URL}/api/misa-sync/continue?run=${id}&hop=${hop}`; }
/** POST the next step. hop = how many self-calls this request chain will have made. */
export async function postContinuation(id:number,hop:number) {
  // Own production origin (set by Vercel), never a caller-controlled host, so the secret stays ours.
  const response=await fetch(continueUrl(id,hop),{
    method:"POST",headers:{Authorization:`Bearer ${process.env.CRON_SECRET}`},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(`Sync continuation HTTP ${response.status}`);
}
async function resumeMorningSync(db:Redis,now:Date) {
  const [run,lock]=await Promise.all([db.get<RunHead>(MORNING_RUN_KEY),db.get(MORNING_RUN_LOCK)]);
  if(shouldResume(run,!!lock,now))await postContinuation(run!.id,1);
}

/** Reuse the existing cron-job.org dispatch ping. One sync each morning, no extra schedule. */
export async function maybeMorningSync(now=new Date()) {
  if(!morningResumeDue(now)||!process.env.CRON_SECRET)return;
  const url=process.env.KV_REST_API_URL??process.env.UPSTASH_REDIS_REST_URL;
  const token=process.env.KV_REST_API_TOKEN??process.env.UPSTASH_REDIS_REST_TOKEN;
  if(!url||!token)throw new Error("Morning sync requires Redis");
  const db=sharedRedis()!,key="sync:morning:trigger:"+vnDate(now),owner=crypto.randomUUID();
  if(!morningSyncDue(now) || await db.set(key,owner,{nx:true,ex:86400})!=="OK")return resumeMorningSync(db,now);
  try {
    const response=await fetch(`${SELF_URL}/api/morning-sync`,{
      headers:{Authorization:`Bearer ${process.env.CRON_SECRET}`},signal:AbortSignal.timeout(15000)});
    const data=await response.json();
    if(!response.ok||!["dispatched","already_completed"].includes(data.status))throw new Error(`Morning sync not started: ${data.status}`);
  }catch(e) {
    await db.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",[key],[owner]);
    throw e;
  }
}
