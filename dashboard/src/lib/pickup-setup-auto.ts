import { autoUpdatePickupEtas } from "./pickup-setup";
import { getRedis, LOCK_TTL_S } from "./tat-archive";
import { vnDate, vnMinutesSinceMidnight } from "./time";

/** Reuse the assign cron after the morning archive. No dashboard needs to be open. */
export async function maybeAutoUpdatePickupEtas(now = new Date()): Promise<void> {
  const minute = vnMinutesSinceMidnight(now);
  if (minute < 6 * 60 || minute >= 7 * 60) return;
  const redis = getRedis();
  if (!redis) return;
  const key = `pickup_setup:auto:${vnDate(now)}`;
  const state = await redis.get<{ done: boolean; failed: number[] }>(key);
  if (state?.done) return;
  if (await redis.set(`${key}:lock`, "1", { nx: true, ex: LOCK_TTL_S }) !== "OK") return;
  // Keep the short lease until expiry, including after failure or process death.
  // An invocation lasts at most 60s; the 90s lease prevents overlapping writes.
  const result = await autoUpdatePickupEtas(state?.failed ?? []);
  const failed = result.results.filter(r => !r.ok);
  await redis.set(key, { done: result.remaining === 0,
    failed: [...(state?.failed ?? []), ...failed.map(r => r.lc_location_id)] }, { ex: 172_800 });
  console.log(`[pickup-setup:auto] updated=${result.results.length - failed.length} failed=${failed.length} remaining=${result.remaining}`);
  for (const row of failed) console.error(`[pickup-setup:auto] ${row.lc_location_id}: ${row.error}`);
}
