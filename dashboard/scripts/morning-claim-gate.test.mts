/**
 * The morning-pass gate: when is it worth spending a command to ask Redis whether
 * today's rollover has already run?
 *
 * Why this is worth a test. The claim it guards is a WRITE, so the question costs
 * a command every time it is asked — ~660 a day to hear "yes, hours ago" for all
 * but the first. Gating it saves ~20k commands a month, and the free tier stops
 * accepting writes at 500k.
 *
 * The dangerous direction is the other one. Gate too hard and a day loses its
 * rollover in silence: if the cron pings were down or the engine sat disarmed all
 * morning, a pure time window would have closed before the engine ever woke, and
 * yesterday's unfinished jobs would stay stranded with nothing in any log to say
 * why. That is what the per-instance clause exists for, and cases 4-6 pin it.
 *
 * No Redis needed — the predicate is pure, which is the whole reason it was
 * split out of claimMorningPass.
 *
 *   npx tsx scripts/morning-claim-gate.test.mts
 */

const { morningClaimIsDue } = await import("../src/lib/smart-log-kv");

const TODAY = "2026-08-25";
const YESTERDAY = "2026-08-24";
const at = (h: number, m = 0) => h * 60 + m;

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!pass) failures++;
}

// 1-3. Inside the window the question is always put, asked-before or not: this is
// the window deferMorningPass retries into, and suppressing a repeat here would
// strand the retry.
check("05:35 first cycle asks", morningClaimIsDue(TODAY, null, at(5, 35)) === true);
check("06:00 asks again after an earlier ask",
  morningClaimIsDue(TODAY, TODAY, at(6)) === true, "defer retries must survive");
check("08:59 still inside the window", morningClaimIsDue(TODAY, TODAY, at(8, 59)) === true);

// 4. The saving: after the window, an instance that already asked today stays quiet.
check("15:00 stays quiet once this instance has asked",
  morningClaimIsDue(TODAY, TODAY, at(15)) === false, "the ~20k/month");

// 5. Late recovery: a fresh instance after the window still asks, so a morning
// lost to downed pings is rolled in late rather than never.
check("15:00 fresh instance still asks",
  morningClaimIsDue(TODAY, null, at(15)) === true, "recovery path");

// 6. The flag is dated, not a boolean — yesterday's ask must not silence today.
check("15:00 asks again on a new day",
  morningClaimIsDue(TODAY, YESTERDAY, at(15)) === true);

// 7. Boundary belongs to the window's far side.
check("09:00 exactly is outside the window",
  morningClaimIsDue(TODAY, TODAY, at(9)) === false);

console.log("");
console.log(failures === 0 ? "all passed" : failures + " FAILED");
process.exitCode = failures === 0 ? 0 : 1;
