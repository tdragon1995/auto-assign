/**
 * The two Redis behaviours the late-pickup panel actually rests on.
 *
 * 1. THE SNAPSHOT'S PARTIAL WRITE. setCycleSnapshot writes only the fields it is
 *    given, and `warnings` carries its own timestamp. So OMITTING warnings freezes
 *    the rows AND their age together, which is what the quiet cycle used to do: the
 *    engine kept running, the heartbeat kept ticking, and the late list silently
 *    stopped being re-examined. Collected pickups then cleared by the reader's
 *    10-minute expiry rather than because anyone noticed. Nothing pinned this, and
 *    it is the mechanism behind two jobs being queried as wrongly flagged
 *    (34437573, 34437718) when both flags were merely stale.
 *
 * 2. THE create_ts CACHE. The stale-window guard needs a job's real booking time,
 *    which the JSON-RPC timeline does not carry, so it asks REST. That answer never
 *    changes — create_ts is stamped once and the overnight rollover re-dates only
 *    scheduled_delivery_ts — yet the cycle read nothing back and re-asked every few
 *    minutes all day. The cache stores the RAW booking time, not the stale/not-stale
 *    verdict, because the verdict legitimately flips when a job is rolled to a new
 *    day and only the raw input survives that.
 *
 *   node scripts/redis-stub.mjs &
 *   npx tsx scripts/late-cache.test.mts
 */

const PORT = Number(process.env.STUB_PORT ?? 8079);
process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${PORT}`;
process.env.UPSTASH_REDIS_REST_TOKEN = "local";
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`;
process.env.KV_REST_API_TOKEN = "local";

const { setCycleSnapshot, getStatusBundle, getResolvedCreateTs, saveResolvedCreateTs } =
  await import("../src/lib/smart-log-kv");
const { isStaleWindow } = await import("../src/lib/assign");

const DAY = "2026-09-04";
const NEXT_DAY = "2026-09-05";

// The stub keeps state for as long as it is running, so a second run would inherit
// the first one's cache and "a cold day knows nothing" would fail for the wrong
// reason. Clear exactly the keys this file writes — not FLUSHDB, which would pull
// the rug from under any other suite sharing the stub.
{
  const { Redis } = await import("@upstash/redis");
  const r = new Redis({ url: `http://127.0.0.1:${PORT}`, token: "local" });
  await r.del("assign:cycle_snapshot", `late:create_ts:${DAY}`, `late:create_ts:${NEXT_DAY}`);
}

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const warning = (job_id: number) => ({
  job_id, reference_number: null, pickup_customer_name: "PK Test", dropoff_customer_name: "BRA",
  driver_id: "d1", driver_name: "Test", reason: "overdue" as const, minutes_late: 58,
  window_time_from: "08:00:00+07:00",
});

// ── 1. Partial write ────────────────────────────────────────────────────────
await setCycleSnapshot({ held: [], failed: [], warnings: [warning(34437573)] });
const first = await getStatusBundle(10);
check("a cycle that computes warnings publishes them", first.warnings.length === 1);
check("...and dates them", !!first.warningsAt, `warningsAt=${first.warningsAt}`);
const firstAt = first.warningsAt;

await new Promise((r) => setTimeout(r, 1100));

// The quiet cycle as it USED to behave: every other field written, warnings omitted.
await setCycleSnapshot({ held: [], failed: [], sheetAlarms: [] });
const frozen = await getStatusBundle(10);
check("omitting warnings leaves the ROWS in place", frozen.warnings.length === 1);
check(
  "omitting warnings leaves the AGE frozen too — the bug in one line",
  frozen.warningsAt === firstAt,
  `was ${firstAt}, now ${frozen.warningsAt}`,
);

// The quiet cycle as it behaves NOW: it computes, so the age advances.
await setCycleSnapshot({ held: [], failed: [], warnings: [warning(34437573)] });
const refreshed = await getStatusBundle(10);
check(
  "a quiet cycle that DOES compute advances the age",
  !!refreshed.warningsAt && refreshed.warningsAt !== firstAt,
  `was ${firstAt}, now ${refreshed.warningsAt}`,
);

// And an empty list must genuinely clear — this is the case the old comment feared,
// and it is only safe because the quiet path now computes instead of guessing.
await setCycleSnapshot({ held: [], failed: [], warnings: [] });
const cleared = await getStatusBundle(10);
check("an explicitly empty list clears the panel", cleared.warnings.length === 0);

// ── 2. create_ts cache ──────────────────────────────────────────────────────
check("a cold day knows nothing", Object.keys(await getResolvedCreateTs(DAY)).length === 0);

await saveResolvedCreateTs(DAY, { 34421121: "2026-08-18 19:48:51" });
const known = await getResolvedCreateTs(DAY);
check("a resolved booking time comes back", known[34421121] === "2026-08-18 19:48:51");
check("...keyed by job id as a number", typeof Object.keys(known).map(Number)[0] === "number");

await saveResolvedCreateTs(DAY, { 34437718: "2026-09-04 18:32:00" });
const both = await getResolvedCreateTs(DAY);
check("a second job is added, not swapped in", !!both[34421121] && !!both[34437718]);

// Blanks are never remembered: one failed fetch must not become a permanent verdict.
await saveResolvedCreateTs(DAY, { 999: "" });
check("a blank is not cached", !(999 in (await getResolvedCreateTs(DAY))));

// Days are separate, so the rollover cannot inherit yesterday's answer by accident.
check("another day is a different cache", Object.keys(await getResolvedCreateTs(NEXT_DAY)).length === 0);

// THE reason the RAW booking time is cached rather than the verdict: the same job,
// the same window, two days — two different correct answers (job 34421121).
const win = "08:00:00+07:00";
const booked = "2026-08-18 19:48:51";
check("stale on the day it was booked for", isStaleWindow(win, "2026-08-18", booked) === true);
check("honest on the day the rollover moved it to", isStaleWindow(win, "2026-08-19", booked) === false);

console.log(failures === 0 ? "\nAll late-cache checks passed." : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
