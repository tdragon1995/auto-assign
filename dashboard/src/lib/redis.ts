import { Redis, type Requester } from "@upstash/redis";
import { sbPatch, sbSelect } from "./supabase-rest";

/**
 * The one Redis client every module uses, ROTATING across up to three Upstash
 * databases: KV_REST_API_URL/_TOKEN (or UPSTASH_REDIS_REST_*), then …_2, then …_3.
 *
 * When the database in use answers that it has hit its plan limit (seen 2026-10-13:
 * 403 "ERR This database has reached current Fixed plan limits"), the request is
 * retried on the next one and the switch is recorded in Supabase `redis_rotation`, so
 * every instance on BOTH Vercel accounts moves together instead of splitting locks and
 * caches across two databases. It only ever moves FORWARD, 1 → 2 → 3 → 1: it does not
 * drift back to an earlier database the moment that one resets, which would land the
 * whole fleet on weeks-old state mid-day.
 *
 * What a switch costs: the new database starts with whatever it last held. Caches
 * rebuild themselves (they check dates and stamps), locks start free, and the
 * distance cache refills from Supabase. The one stale key that can do harm is the
 * engine's manual-off hold, which never expires — so the instance that wins the switch
 * deletes it, and the engine auto-arms in hours as it would on a fresh database.
 *
 * With one database configured this is a plain client: no Supabase reads, no rotation.
 */
type Db = { host: string; client: Requester };

const LIMIT_RE = /plan limits|limit exceeded|max (daily )?requests? limit|bandwidth limit/i;
const POINTER_TTL_MS = 30_000;
const STALE_ON_SWITCH = ["assign:arm_hold"];

let dbs: Db[] | null = null;
let shared: Redis | null = null;
let active = 0;
let checkedAt = 0;
let allFull: { at: number; error: unknown } | null = null;
const ALL_FULL_PAUSE_MS = 60_000;

function accounts(): Db[] {
  if (dbs) return dbs;
  const slots = [
    [process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL, process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN],
    [process.env.KV_REST_API_URL_2, process.env.KV_REST_API_TOKEN_2],
    [process.env.KV_REST_API_URL_3, process.env.KV_REST_API_TOKEN_3],
  ];
  dbs = slots
    .filter((s): s is [string, string] => !!s[0] && !!s[1])
    .map(([url, token]) => ({
      host: new URL(url).host,
      // The real HTTP client of a normal Redis instance: keeps Upstash's own encoding,
      // retries and read-your-writes token. `client` is protected in the types only.
      client: (new Redis({ url, token }) as unknown as { client: Requester }).client,
    }));
  return dbs;
}

/** Index of the database in use, from Supabase at most every 30s. */
async function currentIndex(n: number): Promise<number> {
  if (n === 1) return 0;
  if (Date.now() - checkedAt < POINTER_TTL_MS) return active % n;
  try {
    const [row] = await sbSelect<{ active: number }>("redis_rotation", "select=active&id=eq.1");
    if (row) active = row.active;
  } catch { /* Supabase down: keep the last known database */ }
  checkedAt = Date.now();
  return active % n;
}

/** Move off `from`. Exactly one instance wins the compare-and-set; the rest adopt it. */
async function advance(from: number, n: number, reason: string): Promise<number> {
  const to = (from + 1) % n;
  try {
    const won = await sbPatch<{ active: number }>("redis_rotation", `id=eq.1&active=eq.${from}`,
      { active: to, changed_at: new Date().toISOString(), reason: reason.slice(0, 300) });
    if (won.length) {
      const target = accounts()[to];
      console.warn(`[redis] ${accounts()[from].host} hit its limit — switched to #${to + 1} ${target.host}`);
      await target.client.request({ body: ["del", ...STALE_ON_SWITCH] }).catch(() => {});
      active = to;
    } else {
      checkedAt = 0; // someone else moved it: read where to
      return currentIndex(n);
    }
  } catch {
    active = to; // no Supabase: move this instance anyway rather than fail
  }
  checkedAt = Date.now();
  return to;
}

const requester: Requester = {
  get readYourWrites() { return accounts()[0]?.client.readYourWrites; },
  async request(req) {
    // Every database full: fail fast for a minute rather than walk all of them (and
    // move the Supabase pointer three times) on every single command.
    if (allFull && Date.now() - allFull.at < ALL_FULL_PAUSE_MS) throw allFull.error;
    const list = accounts();
    let i = await currentIndex(list.length);
    let last: unknown;
    for (let tries = 0; tries < list.length; tries++) {
      try {
        const res = await list[i].client.request(req);
        allFull = null;
        return res;
      } catch (e) {
        if (list.length === 1 || !LIMIT_RE.test(String(e))) throw e;
        last = e;
        i = await advance(i, list.length, String(e));
      }
    }
    allFull = { at: Date.now(), error: last };
    throw last;
  },
} as Requester;

/** The shared client, or null when no Redis is configured. */
export function sharedRedis(): Redis | null {
  if (!accounts().length) return null;
  return (shared ??= new Redis(requester));
}
