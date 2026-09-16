/**
 * Payroll reconciliation, operator-only. DRY-RUN BY DEFAULT.
 *
 * Drives POST /api/tat/archive (CRON_SECRET-gated, payroll-only — never tat_legs)
 * one day at a time, sequentially, against the deployment that already holds the
 * Cartrack, Supabase, Redis and distance credentials. No secret is downloaded:
 * the only thing this needs locally is CRON_SECRET.
 *
 *   npx tsx scripts/pay-reconcile.mts                         # dry-run 15/08–14/09
 *   npx tsx scripts/pay-reconcile.mts --from 2026-08-15 --to 2026-09-14 --driver PT101690
 *   npx tsx scripts/pay-reconcile.mts --apply                 # write the REVIEWED dry-run
 *   npx tsx scripts/pay-reconcile.mts --apply --delete reviewed-deletes.json
 *   npx tsx scripts/pay-reconcile.mts --restore 2026-08-20    # roll one day back
 *
 * Output (restricted: payroll data, git-ignored) in reports/pay-reconcile/<from>_<to>/:
 *   <date>.dry.json      diff + exceptions + totals + the stored rows (backup)
 *   <date>.backup.json   the stored rows immediately before apply wrote
 *   <date>.apply.json    what apply wrote / deleted / refused
 *   progress.json        resumable state; a re-run skips finished days
 *   summary.json, summary.md, by-driver.csv
 *
 * --delete file: { "2026-08-20": { "jobs": [123], "punches": [456] } }. Only ids
 * the server still sees as extras are deleted; anything else is refused and listed.
 * Apply refuses a day whose recomputed digest differs from its dry-run — re-run
 * the dry-run for that day (delete its .dry.json) and review again.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name: string, dflt?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const flag = (name: string) => argv.includes(`--${name}`);

const FROM = arg("from", "2026-08-15")!;
const TO = arg("to", "2026-09-14")!;
const BASE = arg("base", "https://diag-logistics.vercel.app")!;
const APPLY = flag("apply");
const RESTORE = arg("restore");
const DRIVER = arg("driver");
const OUT = arg("out", join("reports", "pay-reconcile", `${FROM}_${TO}`))!;

function secret(): string {
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET;
  try {
    const m = /^CRON_SECRET=(.*)$/m.exec(readFileSync(".env.local", "utf8"));
    if (m) return m[1].trim();
  } catch { /* fall through */ }
  throw new Error("CRON_SECRET not set (env or .env.local)");
}
const SECRET = secret();

const days: string[] = [];
for (let d = FROM; d <= TO; ) {
  days.push(d);
  const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); d = x.toISOString().slice(0, 10);
}

mkdirSync(OUT, { recursive: true });
const file = (name: string) => join(OUT, name);
const readJson = <T,>(name: string): T | null => (existsSync(file(name)) ? JSON.parse(readFileSync(file(name), "utf8")) : null);
const writeJson = (name: string, v: unknown) => writeFileSync(file(name), JSON.stringify(v, null, 2));

type Progress = Record<string, { dry?: string; applied?: string; error?: string }>;
const progress: Progress = readJson<Progress>("progress.json") ?? {};
const saveProgress = () => writeJson("progress.json", progress);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(body: unknown): Promise<any> {
  const waits = [5_000, 15_000, 45_000, 90_000];
  for (let i = 0; ; i++) {
    let status = 0;
    let json: { ok?: boolean; retry?: boolean; error?: string } | null = null;
    try {
      const res = await fetch(`${BASE}/api/tat/archive`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": SECRET },
        body: JSON.stringify(body),
      });
      status = res.status;
      json = await res.json().catch(() => null);
      if (status === 401) throw new Error("unauthorized — CRON_SECRET does not match the deployment");
      if (json && (json.ok || !json.retry)) return json;
    } catch (e) {
      if (status === 401) throw e;
      json = { error: e instanceof Error ? e.message : String(e) };
    }
    if (i >= waits.length) return { ok: false, error: `gave up after retries: HTTP ${status} ${json?.error ?? ""}` };
    console.log(`   retry in ${waits[i] / 1000}s (HTTP ${status} ${json?.error ?? ""})`);
    await new Promise((r) => setTimeout(r, waits[i]));
  }
}

async function main() {
  if (RESTORE) {
    const backup = readJson<{ jobs: unknown[]; punches: unknown[] }>(`${RESTORE}.backup.json`);
    if (!backup) throw new Error(`no ${RESTORE}.backup.json in ${OUT}`);
    const r = await post({ date: RESTORE, restore: backup });
    console.log(JSON.stringify(r));
    if (r.ok) { progress[RESTORE] = {}; saveProgress(); }
    return;
  }

  const deletes: Record<string, { jobs?: number[]; punches?: number[] }> =
    arg("delete") ? JSON.parse(readFileSync(arg("delete")!, "utf8")) : {};

  console.log(`${APPLY ? "APPLY" : "DRY-RUN"} ${FROM}..${TO} (${days.length} days) → ${BASE}\nreports: ${OUT}`);

  for (const date of days) {
    const p = (progress[date] ??= {});
    if (!APPLY) {
      if (p.dry && readJson(`${date}.dry.json`)) { console.log(`${date} dry-run done (${p.dry}), skip`); continue; }
      const r = await post({ date });
      if (!r.ok) { p.error = r.error; saveProgress(); console.log(`${date} FAILED: ${r.error}`); continue; }
      writeJson(`${date}.dry.json`, r);
      p.dry = r.digest; delete p.error; saveProgress();
      const d = r.diff;
      console.log(`${date} missing ${d.missing_jobs.length} jobs/${d.missing_punches} punches, changed ${d.changed_jobs.length}/${d.changed_punches}, extra ${d.extra_jobs.length}/${d.extra_punches.length}, exceptions ${r.exceptions.length}`);
      continue;
    }

    const dry = readJson<{ digest: string; backup: unknown }>(`${date}.dry.json`);
    if (!dry) { console.log(`${date} has no reviewed dry-run — skipped`); continue; }
    if (p.applied === dry.digest) { console.log(`${date} already applied (${dry.digest}), skip`); continue; }
    if (!existsSync(file(`${date}.backup.json`))) writeJson(`${date}.backup.json`, dry.backup);

    const r = await post({
      date, apply: true, digest: dry.digest,
      delete_job_ids: deletes[date]?.jobs ?? [], delete_punch_ids: deletes[date]?.punches ?? [],
    });
    if (!r.ok) { p.error = r.error; saveProgress(); console.log(`${date} NOT applied: ${r.error}`); continue; }
    // The state immediately before THIS write is the one a rollback needs.
    writeJson(`${date}.backup.json`, r.backup);
    const { backup: _b, ...rest } = r;
    writeJson(`${date}.apply.json`, rest);
    p.applied = r.digest; delete p.error; saveProgress();
    console.log(`${date} applied: +${r.applied.upserted_jobs} jobs, +${r.applied.upserted_punches} punches, deleted ${r.applied.deleted_job_ids.length}/${r.applied.deleted_punch_ids.length}, refused ${r.applied.refused_deletes.length}`);
  }

  summarize();
}

function summarize() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reports: any[] = days.map((d) => readJson(`${d}.apply.json`) ?? readJson(`${d}.dry.json`)).filter(Boolean);
  const reconciled = days.filter((d) => (APPLY ? progress[d]?.applied : progress[d]?.dry));
  const failed = days.filter((d) => progress[d]?.error).map((d) => ({ date: d, error: progress[d].error }));

  const sum = (k: "before" | "after") => reports.reduce((s, r) => ({
    jobs: s.jobs + r.totals[k].jobs, km: Math.round((s.km + r.totals[k].km) * 100) / 100,
    worked_mins: s.worked_mins + r.totals[k].worked_mins, pay: s.pay + r.totals[k].pay,
  }), { jobs: 0, km: 0, worked_mins: 0, pay: 0 });

  const exceptionCounts: Record<string, number> = {};
  for (const r of reports) for (const e of r.exceptions) exceptionCounts[e.kind] = (exceptionCounts[e.kind] ?? 0) + 1;

  const rows = ["date,driver_id,driver_name,jobs_before,jobs_after,km_before,km_after,mins_before,mins_after,pay_before,pay_after,open_in,stray_out"];
  for (const r of reports) {
    const ids = new Set([...Object.keys(r.totals.by_driver_before), ...Object.keys(r.totals.by_driver_after)]);
    for (const id of ids) {
      const b = r.totals.by_driver_before[id] ?? {}; const a = r.totals.by_driver_after[id] ?? {};
      const name = String(a.driver_name ?? b.driver_name ?? "").replace(/"/g, '""');
      rows.push([r.date, id, `"${name}"`, b.jobs ?? 0, a.jobs ?? 0, b.km ?? 0, a.km ?? 0, b.worked_mins ?? 0, a.worked_mins ?? 0, b.pay ?? 0, a.pay ?? 0, a.open_in ?? 0, a.stray_out ?? 0].join(","));
    }
  }
  writeFileSync(file("by-driver.csv"), "﻿" + rows.join("\n"));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let driverJobs: any[] = [];
  if (DRIVER) {
    for (const r of reports) {
      const after = Object.entries(r.totals.by_driver_after).filter(([, t]) => String((t as { driver_name?: string }).driver_name ?? "").includes(DRIVER));
      for (const [id] of after) {
        // Every source job for the driver = stored-and-unchanged + missing + changed.
        const listed = [...r.diff.missing_jobs, ...r.diff.changed_jobs].filter((j) => j.driver_id === id);
        driverJobs.push({ date: r.date, driver_id: id, total: r.totals.by_driver_after[id], new_or_changed: listed });
      }
    }
  }

  const summary = {
    mode: APPLY ? "apply" : "dry-run", from: FROM, to: TO,
    days_total: days.length, days_reconciled: reconciled.length, failed_days: failed,
    part_time_totals: { before: sum("before"), after: sum("after") },
    diff_totals: {
      missing_jobs: reports.reduce((s, r) => s + r.diff.missing_jobs.length, 0),
      changed_jobs: reports.reduce((s, r) => s + r.diff.changed_jobs.length, 0),
      extra_jobs: reports.reduce((s, r) => s + r.diff.extra_jobs.length, 0),
      missing_punches: reports.reduce((s, r) => s + r.diff.missing_punches, 0),
      changed_punches: reports.reduce((s, r) => s + r.diff.changed_punches, 0),
      extra_punches: reports.reduce((s, r) => s + r.diff.extra_punches.length, 0),
    },
    exception_counts: exceptionCounts,
    ...(DRIVER ? { driver: DRIVER, driver_days: driverJobs } : {}),
  };
  writeJson("summary.json", summary);
  writeFileSync(file("summary.md"), [
    `# Payroll reconciliation ${FROM} – ${TO} (${summary.mode})`,
    `Days reconciled: **${reconciled.length}/${days.length}**${failed.length ? ` — failed: ${failed.map((f) => f.date).join(", ")}` : ""}`,
    ``, `| PT totals | jobs | km | minutes | pay (đ) |`, `|---|---|---|---|---|`,
    `| before | ${summary.part_time_totals.before.jobs} | ${summary.part_time_totals.before.km} | ${summary.part_time_totals.before.worked_mins} | ${summary.part_time_totals.before.pay} |`,
    `| after | ${summary.part_time_totals.after.jobs} | ${summary.part_time_totals.after.km} | ${summary.part_time_totals.after.worked_mins} | ${summary.part_time_totals.after.pay} |`,
    ``, `## Differences`, ...Object.entries(summary.diff_totals).map(([k, v]) => `- ${k}: ${v}`),
    ``, `## Exceptions (review before approval)`, ...Object.entries(exceptionCounts).map(([k, v]) => `- ${k}: ${v}`),
    ``, `Per-day detail: <date>.dry.json / <date>.apply.json. Per driver: by-driver.csv.`,
  ].join("\n"));
  console.log(`\n${reconciled.length}/${days.length} days ${APPLY ? "applied" : "dry-run"}; failed ${failed.length}. Summary: ${file("summary.md")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
