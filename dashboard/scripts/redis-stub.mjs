#!/usr/bin/env node
/**
 * Local stand-in for Upstash Redis, so caching and locking actually run in dev.
 *
 * WHY THIS EXISTS
 * Redis is unconfigured locally, and every guard in this codebase fails OPEN without it:
 * acquireCreateLock returns true, the day snapshot never caches, invalidateConfigCache
 * skips its stamp write. So the behaviour most worth testing — duplicate blocking,
 * cross-instance invalidation, snapshot freshness — is exactly the behaviour that cannot
 * be observed in dev. Bugs in it are only reachable in production.
 *
 * The obvious fix is to point .env.local at the real Upstash database. Do NOT do that.
 * `npm run dev` would then write to the SAME keys production uses: real create locks
 * (a local test would refuse a branch's order for two minutes), the real day snapshot,
 * the real armed state. There is no read-only mode to hide behind.
 *
 * @upstash/redis speaks HTTP, not the Redis wire protocol, so a local redis-server is not
 * a drop-in either. This implements the REST protocol itself against an in-memory Map.
 * No dependencies, no Docker, nothing to install, and it cannot reach the internet.
 *
 * USAGE
 *   node scripts/redis-stub.mjs            # listens on 8079
 *   PORT=9000 node scripts/redis-stub.mjs
 *
 * Then add to dashboard/.env.local and restart `npm run dev`:
 *   UPSTASH_REDIS_REST_URL=http://127.0.0.1:8079
 *   UPSTASH_REDIS_REST_TOKEN=local
 *
 * State lives in memory: restarting clears everything, which is usually what you want
 * between test runs. Single-process, so it models one shared Redis correctly — two
 * `npm run dev` instances pointed at it genuinely contend for the same lock.
 *
 * NOT a Redis implementation. It covers the commands this app actually issues, and
 * answers anything else with an error rather than a plausible lie.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8079);

/** key → { value, expiresAt }. `value` is a string, a string[], or a Map for hashes —
 *  matching how the commands below use it. expiresAt is epoch ms, or null for no TTL. */
const store = new Map();

function alive(key) {
  const rec = store.get(key);
  if (!rec) return null;
  if (rec.expiresAt !== null && Date.now() > rec.expiresAt) {
    store.delete(key); // lazy expiry, same as Redis from a client's point of view
    return null;
  }
  return rec;
}

const str = (v) => (typeof v === "string" ? v : String(v));

/** Redis glob (KEYS/SCAN MATCH) → RegExp. Only * and ? appear in this codebase. */
function globToRe(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

function run(args) {
  if (!Array.isArray(args) || args.length === 0) throw new Error("empty command");
  const cmd = str(args[0]).toUpperCase();
  const a = args.slice(1).map(str);

  switch (cmd) {
    case "PING":
      return "PONG";

    case "SET": {
      const [key, value] = a;
      // Flags arrive in any order: NX, XX, EX <s>, PX <ms>, GET.
      let nx = false, xx = false, ttlMs = null;
      for (let i = 2; i < a.length; i++) {
        const f = a[i].toUpperCase();
        if (f === "NX") nx = true;
        else if (f === "XX") xx = true;
        else if (f === "EX") ttlMs = Number(a[++i]) * 1000;
        else if (f === "PX") ttlMs = Number(a[++i]);
      }
      const existing = alive(key);
      // The NX branch is the whole point of this file: it is what makes
      // acquireCreateLock atomic, and what a missing Redis silently turns into "yes".
      if (nx && existing) return null;
      if (xx && !existing) return null;
      store.set(key, { value, expiresAt: ttlMs === null ? null : Date.now() + ttlMs });
      return "OK";
    }

    case "GET": {
      const rec = alive(a[0]);
      return rec ? rec.value : null;
    }

    case "MGET":
      return a.map((k) => { const r = alive(k); return r ? r.value : null; });

    case "DEL": {
      let n = 0;
      for (const k of a) if (store.delete(k)) n++;
      return n;
    }

    case "EXISTS":
      return a.reduce((n, k) => n + (alive(k) ? 1 : 0), 0);

    case "EXPIRE": {
      const rec = alive(a[0]);
      if (!rec) return 0;
      rec.expiresAt = Date.now() + Number(a[1]) * 1000;
      return 1;
    }

    // Clears a timeout, leaving the value. 1 if a timeout was removed, 0 if the
    // key is gone or already had none — same contract as real Redis.
    case "PERSIST": {
      const rec = alive(a[0]);
      if (!rec || rec.expiresAt === null) return 0;
      rec.expiresAt = null;
      return 1;
    }

    case "TTL": {
      const rec = alive(a[0]);
      if (!rec) return -2;
      if (rec.expiresAt === null) return -1;
      return Math.max(0, Math.round((rec.expiresAt - Date.now()) / 1000));
    }

    case "INCR": {
      const rec = alive(a[0]);
      const next = (rec ? Number(rec.value) : 0) + 1;
      store.set(a[0], { value: String(next), expiresAt: rec?.expiresAt ?? null });
      return next;
    }

    case "HSET": {
      const [key] = a;
      const rec = alive(key);
      const hash = rec?.value instanceof Map ? rec.value : new Map();
      for (let i = 1; i < a.length; i += 2) hash.set(a[i], a[i + 1]);
      store.set(key, { value: hash, expiresAt: rec?.expiresAt ?? null });
      return hash.size;
    }

    case "HGET": {
      const rec = alive(a[0]);
      return rec?.value instanceof Map ? rec.value.get(a[1]) ?? null : null;
    }

    case "HMGET": {
      const rec = alive(a[0]);
      const hash = rec?.value instanceof Map ? rec.value : null;
      return a.slice(1).map((f) => hash?.get(f) ?? null);
    }

    case "HGETALL": {
      const rec = alive(a[0]);
      if (!(rec?.value instanceof Map)) return [];
      // Redis returns a flat [field, value, ...] array; the SDK pairs them up.
      return [...rec.value].flat();
    }

    case "HDEL": {
      const rec = alive(a[0]);
      if (!(rec?.value instanceof Map)) return 0;
      let n = 0;
      for (const f of a.slice(1)) if (rec.value.delete(f)) n++;
      return n;
    }

    case "LPUSH":
    case "RPUSH": {
      const rec = alive(a[0]);
      const list = Array.isArray(rec?.value) ? rec.value : [];
      const items = a.slice(1);
      if (cmd === "LPUSH") list.unshift(...items.reverse());
      else list.push(...items);
      store.set(a[0], { value: list, expiresAt: rec?.expiresAt ?? null });
      return list.length;
    }

    case "LRANGE": {
      const rec = alive(a[0]);
      const list = Array.isArray(rec?.value) ? rec.value : [];
      const start = Number(a[1]);
      const stop = Number(a[2]);
      // Redis stop is inclusive and negatives count from the end.
      const from = start < 0 ? Math.max(0, list.length + start) : start;
      const to = stop < 0 ? list.length + stop : stop;
      return list.slice(from, to + 1);
    }

    case "LTRIM": {
      const rec = alive(a[0]);
      if (!Array.isArray(rec?.value)) return "OK";
      const start = Number(a[1]);
      const stop = Number(a[2]);
      const from = start < 0 ? Math.max(0, rec.value.length + start) : start;
      const to = stop < 0 ? rec.value.length + stop : stop;
      rec.value = rec.value.slice(from, to + 1);
      return "OK";
    }

    case "LLEN": {
      const rec = alive(a[0]);
      return Array.isArray(rec?.value) ? rec.value.length : 0;
    }

    case "KEYS": {
      const re = globToRe(a[0] ?? "*");
      return [...store.keys()].filter((k) => alive(k) && re.test(k));
    }

    case "SCAN": {
      // Returned in one pass with cursor "0". Fine for a dev store of this size, and it
      // keeps callers that loop until cursor==="0" terminating after a single round.
      let match = "*", count = Infinity;
      for (let i = 1; i < a.length; i++) {
        const f = a[i].toUpperCase();
        if (f === "MATCH") match = a[++i];
        else if (f === "COUNT") count = Number(a[++i]);
      }
      const re = globToRe(match);
      const keys = [...store.keys()].filter((k) => alive(k) && re.test(k)).slice(0, count);
      return ["0", keys];
    }

    case "FLUSHDB":
    case "FLUSHALL":
      store.clear();
      return "OK";

    default:
      // Deliberately loud. A silent wrong answer here would look like an app bug.
      throw new Error(`redis-stub: unsupported command ${cmd}`);
  }
}

function exec(body) {
  const one = (args) => {
    try {
      return { result: run(args) };
    } catch (e) {
      return { error: String(e.message ?? e) };
    }
  };
  // A pipeline/multi-exec body is an array of command arrays; a single command is one array.
  return Array.isArray(body?.[0]) ? body.map(one) : one(body);
}

/**
 * @upstash/redis asks for base64 responses by default (`Upstash-Encoding: base64`) and
 * decodes every string it gets back. This stub used to answer in plain text regardless,
 * so the client base64-DECODED plain strings — and the corruption was silent and
 * selective, because only strings whose length is a multiple of 4 and whose characters
 * are all base64-legal decode "successfully" into garbage.
 *
 * That is why it looked like it worked: "failed" (6) and "job_id" survived, while
 * "warnings" (8), "held" (4) and "gaps" (4) came back as mojibake and read as absent.
 * Any hash test on this codebase's own field names was being quietly lied to.
 *
 * So: honour the header the client actually sent. Only strings are encoded — numbers,
 * booleans and nulls travel as themselves, which is what the real service does.
 */
const b64 = (v) =>
  typeof v === "string" ? Buffer.from(v, "utf8").toString("base64")
  : Array.isArray(v) ? v.map(b64)
  : v;

const encodeOut = (out) =>
  Array.isArray(out)
    ? out.map((o) => ("result" in o ? { ...o, result: b64(o.result) } : o))
    : "result" in out ? { ...out, result: b64(out.result) } : out;

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    const wantsB64 = (req.headers["upstash-encoding"] ?? "").toString().toLowerCase() === "base64";
    try {
      const out = exec(raw ? JSON.parse(raw) : []);
      res.end(JSON.stringify(wantsB64 ? encodeOut(out) : out));
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: String(e.message ?? e) }));
    }
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`redis-stub listening on http://127.0.0.1:${PORT} (in-memory, local only)`);
  console.log(`  UPSTASH_REDIS_REST_URL=http://127.0.0.1:${PORT}`);
  console.log(`  UPSTASH_REDIS_REST_TOKEN=local`);
});
