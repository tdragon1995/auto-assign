// Copy every key from one Upstash Redis database to another, preserving TTLs.
// Read-only against the source — safe to run while the app is still live on it.
//
// Get REST URL + token for BOTH databases from the Upstash console (each DB →
// "REST API" tab) or the Vercel Storage tab, then run:
//
//   PowerShell:
//     $env:SRC_REDIS_REST_URL="https://....upstash.io"
//     $env:SRC_REDIS_REST_TOKEN="AX...."
//     $env:DST_REDIS_REST_URL="https://....upstash.io"
//     $env:DST_REDIS_REST_TOKEN="AX...."
//     node scripts/migrate-redis.mjs
//
//   Optional: pass a key pattern to limit scope (default "*", i.e. everything), e.g.
//     node scripts/migrate-redis.mjs "dist:v1:*"
//
// This does NOT touch the source and does NOT delete anything on the
// destination beyond overwriting keys with the same name (SET/HSET/etc.
// overwrite; TTLs are re-applied after each key so nothing is left to live
// forever by accident). Re-running it is safe/idempotent.

import { Redis } from "@upstash/redis";

const srcUrl = process.env.SRC_REDIS_REST_URL;
const srcToken = process.env.SRC_REDIS_REST_TOKEN;
const dstUrl = process.env.DST_REDIS_REST_URL;
const dstToken = process.env.DST_REDIS_REST_TOKEN;

if (!srcUrl || !srcToken || !dstUrl || !dstToken) {
  console.error(
    "Missing credentials. Set SRC_REDIS_REST_URL, SRC_REDIS_REST_TOKEN, " +
      "DST_REDIS_REST_URL, DST_REDIS_REST_TOKEN."
  );
  process.exit(1);
}

const MATCH = process.argv[2] ?? "*";
const src = new Redis({ url: srcUrl, token: srcToken });
const dst = new Redis({ url: dstUrl, token: dstToken });

async function scanAll(redis, match) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, { match, count: 500 });
    keys.push(...batch);
    cursor = next;
  } while (cursor !== "0");
  return keys;
}

async function migrateKey(key) {
  const [type, ttlMs] = await Promise.all([src.type(key), src.pttl(key)]);

  switch (type) {
    case "string": {
      const v = await src.get(key);
      if (v === null) return "missing";
      await dst.set(key, typeof v === "string" ? v : JSON.stringify(v));
      break;
    }
    case "hash": {
      const v = await src.hgetall(key);
      if (v && Object.keys(v).length) await dst.hset(key, v);
      break;
    }
    case "set": {
      const v = await src.smembers(key);
      if (v.length) await dst.sadd(key, ...v);
      break;
    }
    case "list": {
      const v = await src.lrange(key, 0, -1);
      if (v.length) await dst.rpush(key, ...v);
      break;
    }
    case "zset": {
      const v = await src.zrange(key, 0, -1, { withScores: true });
      for (let i = 0; i < v.length; i += 2) {
        await dst.zadd(key, { score: v[i + 1], member: v[i] });
      }
      break;
    }
    default:
      return `skipped (type=${type})`;
  }

  if (ttlMs > 0) await dst.pexpire(key, ttlMs);
  return "ok";
}

async function main() {
  console.log(`Scanning source for keys matching "${MATCH}" ...`);
  const keys = await scanAll(src, MATCH);
  console.log(`Found ${keys.length} keys. Migrating ...`);

  let ok = 0;
  let skipped = 0;
  const errors = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      const result = await migrateKey(key);
      if (result === "ok") ok++;
      else skipped++;
    } catch (e) {
      errors.push({ key, error: String(e) });
    }
    process.stdout.write(`\r  ${i + 1}/${keys.length}`);
  }
  process.stdout.write("\n");

  console.log(`Migrated: ${ok}, skipped: ${skipped}, errors: ${errors.length}`);
  if (errors.length) {
    console.log("Errors:");
    for (const e of errors.slice(0, 20)) console.log(`  ${e.key}: ${e.error}`);
    if (errors.length > 20) console.log(`  ...and ${errors.length - 20} more`);
  }

  const srcCount = keys.length;
  const dstKeys = await scanAll(dst, MATCH);
  console.log(`Source key count: ${srcCount}, destination key count: ${dstKeys.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
