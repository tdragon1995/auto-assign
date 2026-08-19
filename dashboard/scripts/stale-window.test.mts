/**
 * The stale-window gate: a pickup window that had already opened when the job
 * was booked belongs to another day, and must not start today's late clock.
 *
 * Why this is worth a test. Cartrack stores a delivery window as a bare time
 * plus a day offset from the job's scheduled date, so a job dated today with an
 * 08:00 window always reads as "due at 08:00 this morning". A booking taken at
 * 19:48 for an 08:00–09:05 slot is therefore born ~12 hours overdue and clears
 * both the dashboard mark and the Zalo escalation on the first cycle that sees
 * it — the supervisor gets a "trễ ~11h54" ping seconds after the client booked
 * (field case: job 34421121 on 2026-08-18).
 *
 * The gate is a single comparison, which is exactly why it needs pinning: the
 * margin is the only thing separating "this window is for tomorrow" from "this
 * client booked a little way into a live window", and getting it wrong in the
 * generous direction silences real late pickups — a sample nobody is told about.
 * The healthy rows below are real jobs from 2026-08-17/18 that MUST keep warning.
 *
 *   npx tsx scripts/stale-window.test.mts
 */

const { isStaleWindow } = await import("../src/lib/assign");

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// [name, window time_from, the cycle's "today", job create_ts, should suppress]
const cases: [string, string, string, string | null | undefined, boolean][] = [
  // The reported false alert, as the job stood on its creation day.
  ["job 34421121 on 18/08 — booked 19:48 for an 08:00 window", "08:00:00+07:00", "2026-08-18", "2026-08-18 19:48:51", true],
  // Same job after the overnight rollover re-dated it: the window is real now.
  ["job 34421121 on 19/08 — rollover put it on its true day", "08:00:00+07:00", "2026-08-19", "2026-08-18 19:48:51", false],
  // Healthy evening bookings: Cartrack dated these for the NEXT day, so the
  // window sits after create_ts and the clock is right. These must still warn.
  ["job 34419911 — evening booking Cartrack dated for the next day", "07:00:00+07:00", "2026-08-18", "2026-08-17 18:28:04", false],
  ["job 34420029 — evening booking Cartrack dated for the next day", "09:00:00+07:00", "2026-08-18", "2026-08-17 20:49:33", false],
  // A pickup that really is late must never be suppressed.
  ["genuinely late — booked 06:00 for an 08:00 window", "08:00:00+07:00", "2026-08-19", "2026-08-19 06:00:00", false],
  // Booking a little way into a live window is ordinary client behaviour.
  ["client books 20 min into a live window", "08:00:00+07:00", "2026-08-19", "2026-08-19 08:20:00", false],
  ["margin edge — 89 min after the window opened, still ordinary", "08:00:00+07:00", "2026-08-19", "2026-08-19 09:29:00", false],
  ["margin edge — 90 min after the window opened, another day", "08:00:00+07:00", "2026-08-19", "2026-08-19 09:30:00", true],
  // Unresolvable input fails SAFE: keep the warning rather than hide a pickup.
  ["missing create_ts keeps the warning", "08:00:00+07:00", "2026-08-19", null, false],
  ["unparseable window keeps the warning", "not-a-time", "2026-08-19", "2026-08-19 19:00:00", false],
];

for (const [name, win, today, createTs, want] of cases) {
  const got = isStaleWindow(win, today, createTs);
  check(name, got === want, got === want ? "" : `suppressed=${got}, expected ${want}`);
}

console.log(failures === 0 ? "\nAll stale-window checks passed." : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
