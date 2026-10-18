import type { Env } from "./cartrack";
import type { Config } from "./types";
import type { LeaveEntry } from "./leave-config";
import { resolveDriverChoices } from "./fixed-driver";
import { PSC_ROUTES } from "./psc-routes-data";
import { sharedRedis } from "./redis";

/**
 * PSC routes ("pickup|dropoff") whose every driver on duty right now is on leave with no
 * substitute. The /qr page then offers "book and send by Grab" in place of "Đề Nghị Giao
 * Mẫu", and Grab in place of "Chỉ định GNM" on a waiting card.
 *
 * Published by the engine each cycle, from the config and leave it has ALREADY loaded,
 * so the page learns it from one small Redis read instead of a config + leave + fleet
 * lookup per open. Up to one cycle old (~3 min) — the same age as the trip list. The TTL
 * outlives a cycle or two; when the engine is off (night) the key lapses and every
 * branch simply sees its normal booking button.
 */
const key = (env: Env) => `psc:no_driver:${env}`;
const TTL_S = 600;

export function noDriverRoutes(config: Config, leave: LeaveEntry[], now: Date = new Date()): string[] {
  const routes = [...new Set(PSC_ROUTES.filter((r) => !r.no_request).map((r) => `${r.pickup}|${r.dropoff}`))];
  return routes.filter((k) => {
    const [pickup, dropoff] = k.split("|");
    const res = resolveDriverChoices(config, pickup, dropoff, leave, now);
    return !res.ok && res.reason === "all_on_leave";
  });
}

export async function publishNoDriverRoutes(config: Config, leave: LeaveEntry[], env: Env): Promise<void> {
  try {
    await sharedRedis()?.set(key(env), noDriverRoutes(config, leave), { ex: TTL_S });
  } catch (e) {
    console.error("[psc-no-driver] publish", e);
  }
}

/** Empty on any failure: the page falls back to its normal buttons, never to Grab-only. */
export async function readNoDriverRoutes(env: Env): Promise<string[]> {
  try {
    const v = await sharedRedis()?.get<string[]>(key(env));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
