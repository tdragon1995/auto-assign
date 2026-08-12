/**
 * Forensics: which pickup→dropoff pairs got more than one AD-HOC job today, and when?
 *
 * Unlike duplicate-audit.mts this does not filter to jobs whose pickup is still active —
 * a duplicate created this morning may already be finished or cancelled, and would be
 * invisible to a "what is blocking right now" view. It shows every ad-hoc job per pair
 * with its creation time, status and reference, so the sequence can be read directly.
 *
 * Read-only.  cd dashboard && npx tsx scripts/dup-forensics.mts [YYYY-MM-DD]
 */

import { readFileSync } from "node:fs";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const { buildSnapshot } = await import("../src/lib/day-snapshot");
const { pscPairKey, STOP_STATUS, JOB_STATUS } = await import("../src/lib/job-filters");
const { PSC_VIA_LABEL } = await import("../src/lib/via-legs");
const { vnDate } = await import("../src/lib/time");

const DATE = process.argv[2] ?? vnDate();
const snap = await buildSnapshot(DATE, "prod");
if (!snap) {
  console.error("Could not build the day — check CARTRACK_WEB_PASS");
  process.exitCode = 1;
} else {
  const jobs = [...snap.jobs.values()];
  console.log(`\nDuplicate forensics — ${DATE}\n${jobs.length} jobs\n`);

  // Every ad-hoc job per pair, regardless of current status. "Ad-hoc" = no plan attached;
  // planned recurring collections legitimately repeat a pair many times a day.
  const byPair = new Map<string, typeof jobs>();
  for (const j of jobs) {
    if (j.last_assigned_plan_id != null) continue;
    if (j.labels.includes(PSC_VIA_LABEL)) continue;
    const p = j.stops.find((s) => s.stop_type_id === 1 && s.customer_id);
    const d = j.stops.find((s) => s.stop_type_id === 2 && s.customer_id);
    if (!p?.customer_id || !d?.customer_id) continue;
    const k = pscPairKey(p.customer_id, d.customer_id);
    (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(j);
  }

  // A pair booked repeatedly through the day is normal business — samples accumulate and
  // the branch calls again an hour later. A genuine duplicate is two jobs for the same pair
  // created within SECONDS, which is the window every dedup layer is supposed to cover: the
  // 15s in-memory lock, the 120s Redis create lock, and the guard itself.
  const NEAR_MS = 120_000;
  const at = (j: { create_ts: string | null }) => Date.parse((j.create_ts ?? "").replace(" ", "T"));
  const dups = [...byPair.entries()].filter(([, js]) => {
    const sorted = [...js].sort((a, b) => at(a) - at(b));
    return sorted.some((j, i) => i > 0 && at(j) - at(sorted[i - 1]) < NEAR_MS);
  });
  console.log(`ad-hoc pairs today: ${byPair.size}`);
  console.log(`pairs booked twice WITHIN 120s (true duplicates): ${dups.length}\n`);

  for (const [, js] of dups.sort((a, b) => b[1].length - a[1].length)) {
    const from = js[0].stops.find((s) => s.stop_type_id === 1)?.customer_name ?? "?";
    const to = js[0].stops.find((s) => s.stop_type_id === 2)?.customer_name ?? "?";
    console.log(`${from} → ${to}   (${js.length} jobs)`);
    for (const j of js.sort((a, b) => (a.create_ts ?? "").localeCompare(b.create_ts ?? ""))) {
      const pu = j.stops.find((s) => s.stop_type_id === 1);
      console.log(
        `   ${(j.create_ts ?? "?").slice(11)}  job ${j.job_id}  ${(j.reference_number ?? "").padEnd(28)}` +
        ` job=${JOB_STATUS[j.job_status_id ?? 0] ?? j.job_status_id}` +
        `  pickup=${STOP_STATUS[pu?.stop_status_id ?? 0]?.label ?? "?"}` +
        `  driver=${(j.driver.last_name ?? "—").slice(0,18)}` +
        `  batch=${j.item_tracking_numbers.filter(Boolean).join(",") || "(none)"}`,
      );
    }
    console.log("");
  }
}
