/**
 * Does a COLD instance still pay for a fleetweb login?
 *
 * The per-process cookie cache only ever helped a warm lambda. A cold one starts with an
 * empty object and pays a fresh ct_login — a TLS + auth handshake measured at ~280ms of
 * ACTIVE CPU, against ~40-90ms for everything the assign cycle actually computes. With
 * ~340 cron cycles a day that one line was plausibly the single biggest item on the bill.
 *
 * A cold instance is simulated by importing the module twice under different query
 * strings: Node keys its module registry by full specifier, so the second import gets its
 * own module scope — a genuinely empty _cookieCache, which is precisely what a cold lambda
 * has. Instance B must therefore find the cookie in Redis and skip the handshake.
 *
 *   node scripts/redis-stub.mjs &
 *   npx tsx scripts/fleetweb-cookie.test.mts
 *
 * Performs exactly ONE real ct_login against production — the same call the app makes
 * routinely. Redis is the local stub, never the production database.
 */

import { readFileSync } from "node:fs";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const PORT = Number(process.env.STUB_PORT ?? 8079);
process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${PORT}`;
process.env.UPSTASH_REDIS_REST_TOKEN = "local";
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`;
process.env.KV_REST_API_TOKEN = "local";

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "  ok  " : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!pass) failures++;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ cpu: number; wall: number; out: T }> {
  const c0 = process.cpuUsage();
  const w0 = Date.now();
  const out = await fn();
  const c = process.cpuUsage(c0);
  return { cpu: (c.user + c.system) / 1000, wall: Date.now() - w0, out };
}

/**
 * A cartrack module with its own private scope — the simulated cold instance.
 *
 * The `?instance=` suffix is what defeats Node's module cache; it is assembled at runtime
 * because TypeScript would (correctly) refuse to resolve it as a literal path, no such
 * file existing. The cast hands the real module's types back, so this stays type-checked
 * rather than degrading to `any`.
 */
async function freshCartrack(tag: string): Promise<typeof import("../src/lib/cartrack")> {
  const spec = `../src/lib/cartrack?instance=${tag}`;
  return (await import(spec)) as typeof import("../src/lib/cartrack");
}

console.log("\nshared fleetweb cookie: does a cold instance skip the handshake?\n");

// ── Instance A: nothing cached anywhere. Must perform the login. ───────────────
const modA = await freshCartrack("A");
const a = await timed(() => modA.getFleetwebCookie("prod"));
check("instance A got a cookie", !!a.out, a.out ? `${a.cpu.toFixed(1)}ms cpu / ${a.wall}ms wall` : "null — check CARTRACK_WEB_PASS");

// ── Instance B: fresh module scope = a cold lambda. Must read Redis instead. ───
const modB = await freshCartrack("B");
const b = await timed(() => modB.getFleetwebCookie("prod"));
check("instance B got a cookie", !!b.out, b.out ? `${b.cpu.toFixed(1)}ms cpu / ${b.wall}ms wall` : "null");
check("both instances share the SAME session", !!a.out && a.out === b.out,
  a.out === b.out ? "identical" : "different cookies — the shared cache is not being read");
check("cold instance is dramatically cheaper", b.cpu < a.cpu / 3,
  `${a.cpu.toFixed(1)}ms → ${b.cpu.toFixed(1)}ms`);

// ── A rejected session must not linger for other instances to adopt. ──────────
const modC = await freshCartrack("C");
await modC.getFleetwebCookie("prod");            // warm C from the shared cache
const forced = await modC.getFleetwebCookie("prod", true); // force = Cartrack rejected it
check("force re-logs in rather than re-reading the dead session", !!forced, forced ? "new cookie issued" : "null");

if (a.out) {
  const saved = a.cpu - b.cpu;
  console.log(`\n  saved per cold instance: ${saved.toFixed(1)}ms cpu`);
  console.log(`  across ~340 cron cycles/day: ${(saved * 340 / 1000).toFixed(0)}s/day = ${(saved * 340 * 30 / 3_600_000).toFixed(2)} h/month`);
  console.log(`  (of a 4h/month budget — and every other JSON-RPC caller benefits too)`);
}

console.log(failures === 0 ? "\nall passed\n" : `\n${failures} FAILED\n`);
process.exitCode = failures === 0 ? 0 : 1;
