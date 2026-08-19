/**
 * The TAT seal gate: once per day, oldest first, and released again when the
 * archive fails.
 *
 * Why this is worth a test. The gate hangs off the assign cron, which fires every
 * few minutes — so "once per day" is not a nicety, it is the only thing standing
 * between one day-fetch and ~300 of them. And the release-on-failure branch is
 * invisible until the day it matters: claim the seal, fail the archive, keep the
 * seal, and that day is silently lost forever with nothing in any log to say so.
 *
 * The failure is manufactured by withholding Cartrack credentials, which makes
 * getTimelineRoutes return null and archiveDay refuse to write. That refusal is
 * itself load-bearing — it is what stops an empty day from overwriting a good one
 * — so exercising it here covers both guards at once.
 *
 *   node scripts/redis-stub.mjs &
 *   npx tsx scripts/tat-seal.test.mts
 */

const PORT = Number(process.env.STUB_PORT ?? 8079);
process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${PORT}`;
process.env.UPSTASH_REDIS_REST_TOKEN = "local";
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`;
process.env.KV_REST_API_TOKEN = "local";

// Supabase must LOOK configured or archiveSealedDays bails before the gate runs.
// Nothing here ever reaches PostgREST: the Cartrack fetch fails first, by design.
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9/supabase-should-never-be-called";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

// Fail every day-fetch closed, so a released seal is positive proof of the
// failure path rather than of a successful archive.
delete process.env.CARTRACK_WEB_PASS;
delete process.env.CARTRACK_WEB_PASS_UAT;

const { Redis } = await import("@upstash/redis");
const { archiveSealedDays, TAT_LOOKBACK_DAYS } = await import("../src/lib/tat-archive");
const { vnDate, addDays } = await import("../src/lib/time");

const redis = new Redis({ url: process.env.KV_REST_API_URL!, token: "local" });
const today = vnDate();
const sealKey = (d: string) => `tat:sealed:prod:${d}`;
const days = Array.from({ length: TAT_LOOKBACK_DAYS }, (_, i) => addDays(today, -(i + 1)));
const oldest = addDays(today, -TAT_LOOKBACK_DAYS);

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function clearSeals() {
  for (const d of days) await redis.del(sealKey(d));
}

// ── 1. Oldest first, and a failed archive releases its seal ──────────────────
await clearSeals();
const first = await archiveSealedDays();
check("targets the OLDEST unsealed day", first?.date === oldest, `got ${first?.date}, want ${oldest}`);
check("reports the fetch failure rather than writing", first?.ok === false, JSON.stringify(first));
check(
  "releases the seal after a failed archive (so the next ping retries)",
  (await redis.get(sealKey(oldest))) === null,
);

// ── 2. A sealed day is never revisited ───────────────────────────────────────
await clearSeals();
for (const d of days) await redis.set(sealKey(d), Date.now());
const none = await archiveSealedDays();
check("no-ops when every day in the window is already sealed", none === null, JSON.stringify(none));

// ── 3. Only ONE day per call — the catch-up is paced, not a burst ────────────
// Seal everything, then re-open the two oldest. One call must take exactly one.
await clearSeals();
for (const d of days) await redis.set(sealKey(d), Date.now());
await redis.del(sealKey(oldest));
const secondOldest = addDays(today, -(TAT_LOOKBACK_DAYS - 1));
await redis.del(sealKey(secondOldest));

const one = await archiveSealedDays();
check("with two gaps open, handles exactly one", one?.date === oldest, `got ${one?.date}`);
check(
  "leaves the newer gap for the next ping",
  (await redis.get(sealKey(secondOldest))) === null,
);

// ── 4. Today is never sealed by this pass ────────────────────────────────────
await clearSeals();
await archiveSealedDays();
check("never touches today (still moving; /api/tat/me owns it)", (await redis.get(sealKey(today))) === null);

await clearSeals();
console.log(failures === 0 ? "\nAll TAT seal checks passed." : `\n${failures} check(s) FAILED.`);

// Set the code and let Node drain rather than calling process.exit(): forcing an
// exit while the Upstash client's keep-alive sockets are still open aborts libuv
// on Windows ("UV_HANDLE_CLOSING"), which turns a fully passing run into exit 127.
process.exitCode = failures === 0 ? 0 : 1;
