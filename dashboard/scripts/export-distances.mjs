// Export the road-distance cache from Upstash Redis to a CSV.
//
// Credentials are NOT in .env.local (the cache only lives in production, where
// Vercel injects them). Grab the REST URL + token from the Upstash console
// (your DB → "REST API" tab) or Vercel env vars, then run:
//
//   PowerShell:
//     $env:UPSTASH_REDIS_REST_URL="https://....upstash.io"
//     $env:UPSTASH_REDIS_REST_TOKEN="AX...."
//     node scripts/export-distances.mjs
//
//   Optional: pass a key pattern (default "dist:v1:*"), e.g.
//     node scripts/export-distances.mjs "dist:v1:*"
//
// Output: dist-export-<timestamp>.csv in the current directory.

import { Redis } from "@upstash/redis";
import { writeFileSync } from "node:fs";

const url =
  process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const token =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

if (!url || !token) {
  console.error(
    "Missing credentials. Set UPSTASH_REDIS_REST_URL and " +
      "UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL / KV_REST_API_TOKEN)."
  );
  process.exit(1);
}

const MATCH = process.argv[2] ?? "dist:v1:*";
const redis = new Redis({ url, token });

// SCAN the whole keyspace for the pattern (cursor loop, never KEYS).
async function scanAll(match) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, { match, count: 500 });
    keys.push(...batch);
    cursor = next;
  } while (cursor !== "0");
  return keys;
}

// "dist:v1:10.34815,107.07577>10.35166,107.08306" → coord columns.
function parseKey(key) {
  const body = key.replace(/^dist:v1:/, "");
  const [from = "", to = ""] = body.split(">");
  const [fromLat = "", fromLon = ""] = from.split(",");
  const [toLat = "", toLon = ""] = to.split(",");
  return { fromLat, fromLon, toLat, toLon };
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  console.log(`Scanning keys matching "${MATCH}" ...`);
  const keys = await scanAll(MATCH);
  console.log(`Found ${keys.length} keys. Fetching values ...`);

  const rows = [];
  const CHUNK = 256;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    const values = await redis.mget(...slice);
    slice.forEach((key, j) => {
      const raw = values[j];
      // @upstash/redis may auto-parse JSON; handle both object and string.
      const v = typeof raw === "string" ? safeParse(raw) : raw;
      // Prefer the exact coords stored in the value; fall back to the truncated
      // coords parsed from the key for older entries written before that change.
      const k = parseKey(key);
      rows.push({
        key,
        fromLat: v?.from?.lat ?? k.fromLat,
        fromLon: v?.from?.lon ?? k.fromLon,
        toLat: v?.to?.lat ?? k.toLat,
        toLon: v?.to?.lon ?? k.toLon,
        distance_km: v?.distance_km ?? "",
        eta_mins: v?.eta_mins ?? "",
        raw_value: typeof raw === "string" ? raw : JSON.stringify(raw),
      });
    });
    process.stdout.write(`\r  ${Math.min(i + CHUNK, keys.length)}/${keys.length}`);
  }
  process.stdout.write("\n");

  const header = [
    "key",
    "fromLat",
    "fromLon",
    "toLat",
    "toLon",
    "distance_km",
    "eta_mins",
    "raw_value",
  ];
  const lines = rows.map((r) => header.map((h) => csvCell(r[h])).join(","));
  const csv = "﻿" + [header.join(","), ...lines].join("\n");

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `dist-export-${ts}.csv`;
  writeFileSync(file, csv, "utf-8");
  console.log(`Wrote ${rows.length} rows → ${file}`);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
