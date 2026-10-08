import { Redis } from "@upstash/redis";
import { vnDate, vnMinutesSinceMidnight } from "./time";
export function morningSyncDue(now=new Date()) { return vnMinutesSinceMidnight(now)>=300 && vnMinutesSinceMidnight(now)<360; }
/** Reuse the existing cron-job.org dispatch ping. One sync each morning, no extra schedule. */
export async function maybeMorningSync(now=new Date()) {
  if(!morningSyncDue(now)||!process.env.CRON_SECRET)return;
  const url=process.env.KV_REST_API_URL??process.env.UPSTASH_REDIS_REST_URL;
  const token=process.env.KV_REST_API_TOKEN??process.env.UPSTASH_REDIS_REST_TOKEN;
  if(!url||!token)throw new Error("Morning sync requires Redis");
  const db=new Redis({url,token}),key="sync:morning:trigger:"+vnDate(now),owner=crypto.randomUUID();
  if(await db.set(key,owner,{nx:true,ex:86400})!=="OK")return;
  try {
    const response=await fetch("https://diag-logistics.vercel.app/api/morning-sync",{
      headers:{Authorization:`Bearer ${process.env.CRON_SECRET}`},signal:AbortSignal.timeout(15000)});
    const data=await response.json();
    if(!response.ok||!["dispatched","already_completed"].includes(data.status))throw new Error(`Morning sync not started: ${data.status}`);
  }catch(e) {
    await db.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",[key],[owner]);
    throw e;
  }
}
