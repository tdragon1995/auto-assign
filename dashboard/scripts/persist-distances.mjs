// One-off: remove the expiry from distance-cache entries already in Redis.
//
// The code no longer writes a TTL, but keys stored under the old 40-day TTL keep
// their countdown — and the write path is `nx`, so a cache HIT never rewrites
// them. Without this pass they still expire, one Goong re-fetch each.
//
// Read-only by default: it reports how many `dist:v1:*` keys still have a TTL.
// Pass --apply to actually PERSIST them. PERSIST only clears the timeout; the
// value is untouched, and re-running is harmless.
//
//   PowerShell:
//     $env:UPSTASH_REDIS_REST_URL="https://....upstash.io"
//     $env:UPSTASH_REDIS_REST_TOKEN="AX...."
//     node scripts/persist-distances.mjs            # report only
//     node scripts/persist-distances.mjs --apply    # strip the TTLs

import { Redis } from "@upstash/redis";

const url   = process.env.UPSTASH_REDIS_REST_URL   ?? process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

if (!url || !token) {
  console.error("Missing credentials. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const redis = new Redis({ url, token });

const keys = [];
let cursor = "0";
do {
  const [next, batch] = await redis.scan(cursor, { match: "dist:v1:*", count: 500 });
  keys.push(...batch);
  cursor = String(next);
} while (cursor !== "0");

console.log(`Found ${keys.length} dist:v1:* keys.`);

// TTL: -1 = no expiry (already persistent), -2 = key gone, >0 = seconds left.
const CHUNK = 256;
const expiring = [];
let persistent = 0;
let soonest = Infinity;

for (let i = 0; i < keys.length; i += CHUNK) {
  const slice = keys.slice(i, i + CHUNK);
  const pipe = redis.pipeline();
  for (const k of slice) pipe.ttl(k);
  const ttls = await pipe.exec();
  slice.forEach((k, j) => {
    const t = Number(ttls[j]);
    if (t > 0) {
      expiring.push(k);
      if (t < soonest) soonest = t;
    } else if (t === -1) {
      persistent++;
    }
  });
}

console.log(`  already persistent: ${persistent}`);
console.log(`  still expiring:     ${expiring.length}`);
if (expiring.length) {
  console.log(`  soonest expiry:     ${(soonest / 86400).toFixed(1)} days from now`);
}

if (!expiring.length) {
  console.log("Nothing to do.");
  process.exit(0);
}

if (!APPLY) {
  console.log("\nDry run — re-run with --apply to PERSIST these keys.");
  process.exit(0);
}

let done = 0;
for (let i = 0; i < expiring.length; i += CHUNK) {
  const slice = expiring.slice(i, i + CHUNK);
  const pipe = redis.pipeline();
  for (const k of slice) pipe.persist(k);
  await pipe.exec();
  done += slice.length;
  process.stdout.write(`\r  persisted ${done}/${expiring.length}`);
}
process.stdout.write("\n");
console.log("Done. Distance-cache entries no longer expire.");
