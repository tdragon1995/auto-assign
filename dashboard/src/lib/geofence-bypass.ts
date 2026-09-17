import { Redis } from "@upstash/redis";
import { BASE_URL, getHeaders, jsonRpc, type Env } from "./cartrack";
import { appendGeofenceLog } from "./sheets-writer";

/**
 * Temporarily lets a driver complete stops outside the arrival geofence.
 *
 * Cartrack's fleetweb has no per-stop override, only a per-driver setting
 * (`driver_enforce_stop_arrival_range_enabled`). So we switch it off, remember when
 * to switch it back in a Redis sorted set, and the assign cron (pinged every ~1.5 min)
 * restores anything past due. A failed restore stays in the set and retries next ping —
 * the only unsafe outcome is a geofence left open, so nothing is removed until the
 * restore has actually landed.
 *
 * The update RPC is the one the fleetweb driver modal sends. It carries the whole
 * DELIVERY chunk (shift, locations, capabilities), and whether omitted fields are
 * kept or wiped is unverified — so every field is rebuilt from the live REST record
 * rather than sent partial. `shiftWorkDays` has no REST equivalent; the UI sent []
 * for a driver with none set.
 */

export const BYPASS_MINUTES = 5;
const KEY = "geofence:bypass:v1"; // zset: member `${env}|${deliveryDriverId}`, score = revert-at ms
const RADIUS_M = "200";
// list of sheet rows (JSON arrays, GF_LOG_HEADERS order) not yet written to "Mở Geofence Log"
const LOG_KEY = "geofence:log:v1";

function getRedis() {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

interface RestDriver {
  delivery_driver_id: string;
  fleet_driver_id: string;
  registration: string | null;
  start_location_customer_id: string | null;
  end_location_customer_id: string | null;
  shift_time_start: string | null;
  shift_time_end: string | null;
  subuser_id: string | null;
  max_weight: number | null;
  max_volume: number | null;
  special_equipment: { equipment_id: number }[] | null;
}

async function setGeofence(deliveryDriverId: string, enforce: boolean, env: Env): Promise<string | null> {
  const res = await fetch(`${BASE_URL}/drivers/${deliveryDriverId}`, { headers: getHeaders(env), cache: "no-store" });
  const d = ((await res.json().catch(() => null)) as { data?: RestDriver } | null)?.data;
  if (!res.ok || !d?.fleet_driver_id) return `Không đọc được tài xế (HTTP ${res.status})`;

  const out = await jsonRpc("ct_fleet_update_client_driver_details_chunk", {
    type: "DELIVERY",
    client_driver_id: d.fleet_driver_id,
    client_driver_data: {
      id: d.delivery_driver_id,
      registration: d.registration,
      startLocationCustomerId: d.start_location_customer_id,
      endLocationCustomerId: d.end_location_customer_id,
      shiftTimeStart: d.shift_time_start,
      shiftTimeEnd: d.shift_time_end,
      itemContainer: {
        maxWeight: d.max_weight,
        maxVolume: d.max_volume,
        deliveryCapabilities: (d.special_equipment ?? []).map((e) => e.equipment_id),
      },
      subuserId: d.subuser_id,
      shiftWorkDays: [],
      updateDriverSettings: [
        { setting_key: "driver_enforce_stop_arrival_range_radius", setting_value: RADIUS_M },
        { setting_key: "driver_enforce_stop_arrival_range_enabled", setting_value: String(enforce) },
      ],
    },
  }, { env });
  return out.ok ? null : out.error;
}

/** Opens the geofence and schedules the restore. Schedules BEFORE opening, so a crash
 *  between the two can only cause a harmless extra restore, never an unrestored open. */
export async function openGeofence(deliveryDriverId: string, env: Env): Promise<{ error: string } | { until: number }> {
  const redis = getRedis();
  if (!redis) return { error: "Redis chưa cấu hình — không thể hẹn giờ khoá lại" };
  const until = Date.now() + BYPASS_MINUTES * 60_000;
  await redis.zadd(KEY, { score: until, member: `${env}|${deliveryDriverId}` });
  const err = await setGeofence(deliveryDriverId, false, env);
  if (err) {
    await redis.zrem(KEY, `${env}|${deliveryDriverId}`).catch(() => {});
    return { error: err };
  }
  return { until };
}

/** Queue one log row. Written to the sheet later by the cron, so the button never waits
 *  on Google. */
export async function queueBypassLog(row: (string | number)[]): Promise<void> {
  await getRedis()?.rpush(LOG_KEY, JSON.stringify(row));
}

/** Write every queued row in one append, then drop exactly those rows (new ones are
 *  pushed to the tail, so LTRIM from n keeps them). Left queued on failure → retried. */
async function flushBypassLog(redis: Redis): Promise<void> {
  const raw = await redis.lrange<unknown>(LOG_KEY, 0, -1);
  if (!raw.length) return;
  const rows = raw.map((r) => (typeof r === "string" ? JSON.parse(r) : r) as (string | number)[]);
  await appendGeofenceLog(rows);
  await redis.ltrim(LOG_KEY, rows.length, -1);
}

/** Called from the assign cron. One ZRANGE per ping when nothing is due. The sheet log
 *  is flushed only when something IS due: every open queues its row before its restore
 *  comes due, so this costs no command on an idle ping. */
export async function restoreExpiredGeofences(): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  const due = await redis.zrange<string[]>(KEY, 0, Date.now(), { byScore: true });
  if (due.length) {
    await flushBypassLog(redis).catch((e) => console.error("[geofence] sheet log flush failed:", e instanceof Error ? e.message : e));
  }
  let restored = 0;
  for (const member of due) {
    const [env, id] = member.split("|") as [Env, string];
    const err = await setGeofence(id, true, env);
    if (err) { console.error(`[geofence] restore failed for ${member}: ${err}`); continue; }
    await redis.zrem(KEY, member);
    restored++;
  }
  return restored;
}
