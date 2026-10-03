import { Redis } from "@upstash/redis";
import { readConfigGen } from "./config-gen";
import { sbSelectAll } from "./supabase-rest";

type Choices={locations:{id:string;name:string}[];drivers:{driver_id:string;name:string}[]};
type Cached=Choices&{gen:string|null;at:number};
let cached:Cached|null=null;
const KEY="master:choices:v1",TTL=300;
/** Slim names/IDs only. Profile writes and manual refresh already bump config:gen. */
export async function masterChoices():Promise<Choices> {
  const gen=await readConfigGen(),now=Date.now();
  if(cached && cached.gen===gen && now-cached.at<TTL*1000) return cached;
  const url=process.env.KV_REST_API_URL??process.env.UPSTASH_REDIS_REST_URL;
  const token=process.env.KV_REST_API_TOKEN??process.env.UPSTASH_REDIS_REST_TOKEN;
  const redis=url&&token?new Redis({url,token}):null;
  if(redis) try {
    const hit=await redis.get<Cached>(KEY);
    if(hit?.gen===gen && now-hit.at<TTL*1000) {cached=hit;return hit;}
  } catch { /* Read Supabase when Redis is unavailable. */ }
  const [clients,drivers]=await Promise.all([
    sbSelectAll<{customer_id:string;customer_name:string}>("master_clients","select=customer_id,customer_name&is_active=eq.true","customer_id.asc"),
    sbSelectAll<{driver_id:string;first_name:string|null;last_name:string|null}>("master_drivers","select=driver_id,first_name,last_name&or=(is_active.is.null,is_active.eq.true)","driver_id.asc")]);
  cached={gen,at:now,locations:clients.filter(c=>c.customer_name?.trim()).map(c=>({id:c.customer_id,name:c.customer_name})),
    drivers:drivers.map(d=>({driver_id:d.driver_id,name:`${d.first_name??""} ${d.last_name??""}`.trim()||d.driver_id}))};
  // An older request's payload carries its old generation, so readers reject it after a write.
  if(redis) try {await redis.set(KEY,cached,{ex:TTL});} catch { /* cache is best-effort */ }
  return cached;
}
