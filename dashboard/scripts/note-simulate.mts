/**
 * What would a given set of sentences actually have released?
 *
 * Coverage is NOT the sum of the appearance counts in note-scan's table: a job
 * is released only when EVERY note on it is on the list, so a common sentence
 * sharing jobs with rare ones buys less than it looks like it should. This
 * prices a real list against the days note-scan already read, so choosing what
 * to accept costs no further Cartrack traffic.
 *
 * Reads the replay file note-scan writes when NOTE_SCAN_DUMP is set, and a list
 * of candidate sentences (one per line, as typed — normalized here). Prints the
 * honest release rate, and what each sentence adds on its own.
 *
 *   cd dashboard && NOTE_SCAN_DUMP=note-scan.json npx tsx scripts/note-scan.mts --days=45
 *   cd dashboard && npx tsx scripts/note-simulate.mts note-scan.json accept.txt
 */

import { readFileSync } from "node:fs";
import { normalizeNote } from "../src/lib/job-filters";

const [dumpPath, listPath] = process.argv.slice(2);
if (!dumpPath || !listPath) {
  console.error("usage: note-simulate.mts <replay.json> <sentences.txt>");
  process.exit(1);
}

const { days, heldJobsDay, heldJobsEve, heldDayNotes } = JSON.parse(readFileSync(dumpPath, "utf8")) as {
  days: number; heldJobsDay: number; heldJobsEve: number; heldDayNotes: string[][];
};

const wanted = readFileSync(listPath, "utf8")
  .split(/\r?\n/)
  .map((l) => l.replace(/^\s*#.*$/, "").trim())
  .filter(Boolean)
  .map(normalizeNote)
  .filter(Boolean);

const released = (list: Set<string>) => heldDayNotes.filter((ns) => ns.every((n) => list.has(n))).length;

const full = new Set(wanted);
const total = released(full);
const pct = (n: number) => (heldJobsDay ? Math.round((n / heldJobsDay) * 100) : 0);

console.log(`\n${wanted.length} sentence(s) against ${days} days of history\n`);
console.log(`  ${heldJobsDay} jobs held for a note in the working day`);
console.log(`  ${total} would have gone out on their own — ${pct(total)}%`);
console.log(`  ${heldJobsEve} more held after 19:30, untouched by design\n`);

console.log("What each sentence is worth (jobs lost if it were dropped):");
const worth = wanted
  .map((s) => {
    const without = new Set(wanted.filter((x) => x !== s));
    return { s, delta: total - released(without) };
  })
  .sort((a, b) => b.delta - a.delta);
for (const w of worth) console.log(`  ${String(w.delta).padStart(4)}   ${w.s}`);

const dead = worth.filter((w) => w.delta === 0);
if (dead.length) {
  console.log(`\n${dead.length} sentence(s) release nothing on their own — they only ever appear`);
  console.log("beside a note that is not on the list. Harmless to keep, honest to know.");
}
