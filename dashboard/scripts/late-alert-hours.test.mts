/**
 * The quiet hours on the Zalo late-pickup escalation.
 *
 * The push reaches a supervisor's phone, so the window it may fire in is a people
 * decision, not a technical one, and the numbers below are the decision: nothing
 * before 09:00 (the 07:00 clock floor plus the two-hour mark) and nothing from
 * 21:30, half an hour before the engine disarms at 22:00. A ping in that last half
 * hour names a pickup nobody is going to dispatch a driver for tonight.
 *
 * Worth pinning because a boundary written as `21 * 60 + 30` is one keystroke from
 * 09:30 — which would leave a THIRTY-MINUTE window in which any alert could fire at
 * all, and the failure is silent: no error, just a supervisor who stops hearing
 * about stuck samples.
 *
 * The dashboard row is deliberately NOT gated by this — the panel keeps showing the
 * late pickup at every hour. Only the phone push is quiet.
 *
 *   npx tsx scripts/late-alert-hours.test.mts
 */

const { isLateAlertHour } = await import("../src/lib/assign");

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** A VN wall-clock time on an ordinary working day. */
const at = (hhmm: string) => new Date(`2026-09-04T${hhmm}:00+07:00`);

// [name, VN time, may the push fire]
const cases: [string, string, boolean][] = [
  // The working day: the escalation must keep working. These are the rows whose
  // failure costs a sample nobody is told about.
  ["09:00 — earliest an alert can exist (07:00 floor + 2h)", "09:00", true],
  ["midday", "12:30", true],
  ["evening peak, when late pickups actually cluster", "18:45", true],
  ["20:11 — the cycle that produced job 34437718's row", "20:11", true],

  // The boundary itself, from both sides.
  ["21:29 — last minute a push may fire", "21:29", true],
  ["21:30 — the cutoff, exclusive", "21:30", false],
  ["21:31", "21:31", false],

  // The quiet tail before the engine disarms at 22:00.
  ["21:45 — engine still armed, supervisor off duty", "21:45", false],
  ["23:59", "23:59", false],

  // Overnight and early morning. No alert can be due here anyway (the clock floors
  // at 07:00), but the predicate must not be the thing that would have allowed one.
  ["00:00", "00:00", true],
  ["05:30 — engine arms", "05:30", true],

  // Guard against the 09:30 typo: if the cutoff were misread as 9h30, this would
  // answer false and the whole afternoon would go silent.
  ["09:31 — false here would mean the cutoff was set to 09:30", "09:31", true],
];

for (const [name, hhmm, want] of cases) {
  const got = isLateAlertHour(at(hhmm));
  check(name, got === want, got === want ? "" : `mayAlert=${got}, expected ${want}`);
}

console.log(failures === 0 ? "\nAll late-alert-hour checks passed." : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
