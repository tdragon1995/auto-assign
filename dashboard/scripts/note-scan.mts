/**
 * Which stop notes are actually harmless?
 *
 * The assign engine holds any job that carries a note, and a supervisor clears it
 * by hand. Most of those notes are the same few sentences over and over. This
 * report finds them, from what really happened rather than from guessing, and
 * proposes the ones safe enough to let through on their own.
 *
 * For every distinct sentence it counts two opposite signals:
 *
 *   APPROVED   the note carries the "Giao ngay" tick — a supervisor read it and
 *              said "send it as-is". Evidence the sentence is harmless.
 *   SCHEDULED  the job ended up with a pickup time window — evidence the note
 *              CHANGED something, so the sentence is not harmless.
 *
 * Evening bookings are counted SEPARATELY and excluded from the verdict. Jobs
 * booked after 19:30 get pushed to the next day because the shifts have ended —
 * that is a decision about the hour, not about the sentence, and counting it
 * against the sentence would condemn exactly the notes that cost the most clicks.
 *
 * Honest limits, so nobody over-reads the table:
 *   - a job can carry a time window because it was BOOKED that way, not because a
 *     supervisor set one, so SCHEDULED is a strong hint, not proof;
 *   - the tick only exists on jobs since that button shipped, so older approvals
 *     are invisible here and sentences will look quieter than they were.
 *
 * The report proposes. A human reads the table and decides what goes on the list
 * in src/lib/job-filters.ts.
 *
 * Read-only: it fetches days and prints. It changes nothing, and it drops the
 * Redis credentials before loading any app code so it cannot touch live state.
 *
 *   cd dashboard && npx tsx scripts/note-scan.mts --days=45
 *   cd dashboard && npx tsx scripts/note-scan.mts --days=60 --min=5
 */

import { readFileSync, writeFileSync } from "node:fs";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
// Never read or write live dashboard state while reporting on it.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const { getJobsByDate } = await import("../src/lib/cartrack");
const { normalizeNote, isBlockingNote, NOTE_APPROVED_MARK, NOTE_RELEASE_CUTOFF_MIN } =
  await import("../src/lib/job-filters");
const { vnDate, addDays, parseVnTimestamp, vnMinutesSinceMidnight } = await import("../src/lib/time");

const arg = (name: string, dflt: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const n = hit ? Number(hit.split("=")[1]) : NaN;
  return Number.isFinite(n) ? n : dflt;
};
const DAYS = arg("days", 45);
const MIN_APPROVALS = arg("min", 3);
const env = (process.argv.find((a) => a.startsWith("--env="))?.split("=")[1] ?? "prod") as "prod" | "uat";

type Row = {
  total: number;
  branches: Set<string>;
  dayApproved: number;
  dayScheduled: number;
  dayPlain: number;
  eveApproved: number;
  eveScheduled: number;
  evePlain: number;
  sample: string;          // the sentence as a branch actually typed it
};

const rows = new Map<string, Row>();

/** Jobs that the note gate would have held: a real note, and no time window of
 *  their own (a windowed job bypasses the gate already). */
let heldJobsDay = 0;
let heldJobsEve = 0;
/** Of those, the ones whose notes are ALL proposed candidates — the payoff. */
const heldDayNotes: string[][] = [];

const cutoffLabel = `${String(Math.floor(NOTE_RELEASE_CUTOFF_MIN / 60)).padStart(2, "0")}:${String(NOTE_RELEASE_CUTOFF_MIN % 60).padStart(2, "0")}`;

const today = vnDate();
const dates: string[] = [];
for (let i = 1; i <= DAYS; i++) dates.push(addDays(today, -i));
dates.reverse();

console.log(`Reading ${DAYS} days (${dates[0]} → ${dates[dates.length - 1]}) on ${env}…`);

let scanned = 0;
// Cartrack answers 500 for some dates (seen on 5 consecutive days of 2026-07).
// Skipping keeps the report useful, but the count has to be visible: a silently
// short window makes every sentence look rarer, and rarity is what the verdict
// turns on.
const skippedDays: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const date of dates) {
  // A day is up to ten 1000-row pages, and Cartrack starts answering 500 when
  // those are fired back to back — whole weeks vanished from an early run of
  // this report. One patient retry recovers nearly all of them.
  let jobs;
  try {
    jobs = await getJobsByDate(date, env);
  } catch {
    await sleep(5000);
    try {
      jobs = await getJobsByDate(date, env);
    } catch (e) {
      console.warn(`  ${date}: skipped (${e})`);
      skippedDays.push(date);
      continue;
    }
  }
  await sleep(400);
  scanned += jobs.length;
  process.stdout.write(`  ${date}: ${jobs.length} jobs\r`);

  for (const job of jobs) {
    const stops = job.stops ?? [];
    const pickup = stops.find((s) => s.stop_type_id === 1);
    const branch = pickup?.customer_name ?? pickup?.customer_id ?? "—";
    const windowed = !!pickup?.delivery_windows?.[0]?.time_from;

    // When was it BOOKED — that is what the evening cutoff is about.
    const created = parseVnTimestamp(job.create_ts ?? "");
    const evening = !isNaN(created.getTime())
      && vnMinutesSinceMidnight(created) >= NOTE_RELEASE_CUTOFF_MIN;

    const jobNotes: string[] = [];
    for (const stop of stops) {
      const raw = (stop.note ?? "").trim();
      if (!raw || !isBlockingNote(raw)) continue;   // blank + the old always-exempt sentence
      const key = normalizeNote(raw);
      if (!key) continue;
      jobNotes.push(key);

      let r = rows.get(key);
      if (!r) {
        r = { total: 0, branches: new Set(), dayApproved: 0, dayScheduled: 0, dayPlain: 0,
              eveApproved: 0, eveScheduled: 0, evePlain: 0, sample: raw.split(NOTE_APPROVED_MARK).join("").trim() };
        rows.set(key, r);
      }
      r.total++;
      r.branches.add(branch);
      const approved = raw.includes(NOTE_APPROVED_MARK);
      if (evening) {
        if (approved) r.eveApproved++;
        else if (windowed) r.eveScheduled++;
        else r.evePlain++;
      } else {
        if (approved) r.dayApproved++;
        else if (windowed) r.dayScheduled++;
        else r.dayPlain++;
      }
    }

    // The gate only holds a job that has no window of its own.
    if (jobNotes.length > 0 && !windowed) {
      if (evening) heldJobsEve++;
      else { heldJobsDay++; heldDayNotes.push(jobNotes); }
    }
  }
}
console.log(`\nScanned ${scanned} jobs, ${rows.size} distinct sentences.\n`);

const hasDigits = (s: string) => /\d/.test(s);

const all = [...rows.entries()].sort((a, b) => b[1].total - a[1].total);
const candidates = all.filter(([, r]) => r.dayApproved >= MIN_APPROVALS && r.dayScheduled === 0);
const candidateKeys = new Set(candidates.map(([k]) => k));

const wouldRelease = heldDayNotes.filter((ns) => ns.every((n) => candidateKeys.has(n))).length;

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const num = (n: number, w = 4) => String(n).padStart(w);

console.log(`CANDIDATES — approved ${MIN_APPROVALS}+ times in the working day, never scheduled in the working day`);
console.log("");
console.log(`${pad("sentence", 52)} ${num(0).replace(/0/, "n")}  seen  appr  sched   |  evening appr/sched  branches  digits`);
console.log("-".repeat(120));
for (const [, r] of candidates) {
  console.log(
    `${pad(r.sample, 52)}      ${num(r.total)}  ${num(r.dayApproved)}  ${num(r.dayScheduled, 5)}   |` +
    `        ${num(r.eveApproved)}/${num(r.eveScheduled, 1)}      ${num(r.branches.size, 4)}   ${hasDigits(r.sample) ? "yes" : "no"}`
  );
}
if (candidates.length === 0) console.log("  (none yet — nothing has been approved often enough to be safe)");

console.log("");
console.log(`REJECTED — approved but ALSO scheduled at least once in the working day (top 15)`);
console.log("-".repeat(120));
const rejected = all.filter(([, r]) => r.dayApproved > 0 && r.dayScheduled > 0).slice(0, 15);
for (const [, r] of rejected) {
  console.log(`${pad(r.sample, 52)}      ${num(r.total)}  ${num(r.dayApproved)}  ${num(r.dayScheduled, 5)}`);
}
if (rejected.length === 0) console.log("  (none)");

console.log("");
console.log(`MOST COMMON, no verdict yet — never approved, never scheduled (top 20)`);
console.log("-".repeat(120));
const undecided = all.filter(([, r]) => r.dayApproved === 0 && r.dayScheduled === 0).slice(0, 20);
for (const [, r] of undecided) {
  console.log(`${pad(r.sample, 52)}      ${num(r.total)}   seen at ${r.branches.size} branch(es)`);
}

console.log("");
console.log("=".repeat(72));
const readDays = DAYS - skippedDays.length;
if (skippedDays.length) {
  console.log(`(${skippedDays.length} of ${DAYS} days could not be read: ${skippedDays.join(", ")})`);
}
console.log(`Over ${readDays} days:`);
console.log(`  ${heldJobsDay} jobs were held for a note during the working day (before ${cutoffLabel}).`);
console.log(`  ${wouldRelease} of them (${heldJobsDay ? Math.round((wouldRelease / heldJobsDay) * 100) : 0}%) would have gone out on their own with these ${candidates.length} sentence(s).`);
console.log(`  ${heldJobsEve} more were held after ${cutoffLabel} — left alone by design, still yours to schedule.`);
console.log("=".repeat(72));

const csv = [
  "sentence,seen,branches,day_approved,day_scheduled,day_plain,eve_approved,eve_scheduled,eve_plain,has_digits,candidate",
  ...all.map(([k, r]) =>
    [JSON.stringify(r.sample), r.total, r.branches.size, r.dayApproved, r.dayScheduled, r.dayPlain,
     r.eveApproved, r.eveScheduled, r.evePlain, hasDigits(r.sample) ? 1 : 0, candidateKeys.has(k) ? 1 : 0].join(",")),
].join("\n");
const out = process.env.NOTE_SCAN_OUT ?? "note-scan.csv";
writeFileSync(out, "﻿" + csv, "utf8");   // BOM so Excel reads the Vietnamese
console.log(`\nFull table: ${out}`);

// The held jobs as sets of note keys, so a different choice of sentences can be
// priced WITHOUT re-reading 45 days from Cartrack. Coverage is not additive — a
// job is only released when EVERY note on it is listed — so guessing from the
// appearance counts above overstates the gain. See scripts/note-simulate.mts.
const dump = process.env.NOTE_SCAN_DUMP;
if (dump) {
  writeFileSync(dump, JSON.stringify({ days: readDays, heldJobsDay, heldJobsEve, heldDayNotes }), "utf8");
  console.log(`Replay data: ${dump}`);
}
console.log(`Paste the sentences you accept into DAYTIME_NON_BLOCKING in src/lib/job-filters.ts (normalized, lowercase).`);
