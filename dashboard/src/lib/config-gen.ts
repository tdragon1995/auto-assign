import { Redis } from "@upstash/redis";

/**
 * The shared config invalidation stamp, on its own so more than one reader can
 * honour it.
 *
 * `config.ts` has had this for a while: in-memory caches are per-instance by
 * nature, so a Refresh could only ever clear the instance that served it and
 * every other warm one kept its copy until it was recycled. Comparing a few
 * bytes against a stamp fixes that for the price of one tiny GET.
 *
 * It lives here rather than in `config.ts` because `/api/config/rows` needs the
 * same signal and deliberately does NOT go through `loadConfigFromSheets` — it
 * keeps its own slim copy of the table, with sheet rows and branch names that
 * the parsed `Mapping` does not carry. Importing the whole parser just to read a
 * key would drag the config engine into that route's bundle.
 */
const GEN_KEY = "config:gen";

function getRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/**
 * Current stamp, or null when Redis is unconfigured or unreachable.
 *
 * Null means "no reason to invalidate", deliberately: a Redis blip that made
 * every instance re-download the sheet at the same moment is a worse failure
 * than briefly missing a Refresh.
 */
export async function readConfigGen(): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return (await redis.get<string>(GEN_KEY)) ?? null;
  } catch {
    return null;
  }
}

/** Move the stamp on, so every warm instance drops its copy at its next load.
 *  Best-effort: a failed write degrades to per-instance invalidation, never to
 *  an error. */
export async function bumpConfigGen(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(GEN_KEY, String(Date.now()));
  } catch { /* best-effort */ }
}

export { GEN_KEY };
