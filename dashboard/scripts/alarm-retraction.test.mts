/**
 * Pins that a stale alarm can actually be retracted.
 *
 * Publishing is change-only, so a healthy fleet writes nothing. On its own that
 * has a hole: an instance can only CLEAR what it previously set, so once a
 * condition goes away while no live instance holds it, the last published alarm
 * is immortal. That is what left a wrong, red, no-longer-true warning from 10:51
 * standing on the dashboard across four deploys on 2026-08-31 — every fresh
 * instance found nothing wrong and therefore said nothing at all.
 *
 * Needs a virgin module, so it lives in its own process.
 *
 *   npx tsx scripts/alarm-retraction.test.mts
 */
const { noteSheetWarning, drainSheetAlarms } = await import("../src/lib/sheets");

let failed = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) return console.log(`  ok   ${label}`);
  failed++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
}

// Before anything has been read, silence — an instance that has not looked must
// never publish an empty set over someone else's real alarm.
ok("says nothing before it has looked at anything", drainSheetAlarms() === null);

// A clean check on a fresh process. Nothing is wrong, nothing CHANGED in this
// process's own map — and it must still report, because that empty report is
// what retracts whatever a previous instance left behind.
noteSheetWarning("config — trùng giờ", null);
const first = drainSheetAlarms();
ok("a clean first check still reports", first !== null);
ok("...and reports emptiness, which is what clears a stale alarm", first?.length === 0);

// Afterwards, change-only resumes: a healthy fleet must not write every cycle.
ok("a second clean check says nothing", drainSheetAlarms() === null);
noteSheetWarning("config — trùng giờ", null);
ok("...and neither does a repeat of the same clean result", drainSheetAlarms() === null);

// A real change still reports, as before.
noteSheetWarning("config — trùng giờ", "1 cặp dòng TRÙNG GIỜ");
const raised = drainSheetAlarms();
ok("a new problem reports", raised?.length === 1);
ok("...tagged as a data problem, not an unreadable tab", raised?.[0].kind === "data");
ok("the same problem again says nothing", drainSheetAlarms() === null);

// And clearing it reports the retraction.
noteSheetWarning("config — trùng giờ", null);
ok("fixing it reports the retraction", (drainSheetAlarms() ?? null)?.length === 0);

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
