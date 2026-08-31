/**
 * Pins which times each of the three ways to close a gap will accept.
 *
 * Overlap is the one fault a person cannot see coming here: two rules live at
 * the same minute make the engine refuse the job outright, and the sheet gives
 * no hint it is about to happen. So the picker greys the offending times out
 * rather than letting them be chosen and reported afterwards.
 *
 *   npx tsx scripts/gap-choices.test.mts
 */
let failed = 0;
function ok(label: string, cond: boolean) {
  if (cond) return console.log(`  ok   ${label}`);
  failed++;
  console.log(`  FAIL ${label}`);
}

const toMin = (v: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};

// The three predicates as the component applies them. Branch: cover 07:00–14:30
// then 16:30–19:00, so the hole is 14:30–16:30.
const beforeEnd = "14:30", afterStart = "16:30";
const busy: [string, string][] = [["07:00", "14:30"], ["16:30", "19:00"]];

const endDisabled = (t: string) => {
  const m = toMin(t), cur = toMin(beforeEnd), lim = toMin(afterStart);
  return m <= cur || m > lim;
};
const startDisabled = (t: string) => {
  const m = toMin(t), cur = toMin(afterStart), lim = toMin(beforeEnd);
  return m >= cur || m < lim;
};
const insideBusy = (t: string) => {
  const m = toMin(t);
  return busy.some(([f, e]) => {
    const a = toMin(f), b = toMin(e);
    return a < b ? m > a && m < b : m > a || m < b;
  });
};

console.log("\nextending the EARLIER rule's end (07:00–14:30 →)");
ok("cannot shrink it", endDisabled("14:00"));
ok("cannot pick the time it already ends", endDisabled("14:30"));
ok("can grow into the hole", !endDisabled("15:10"));
ok("can close the hole exactly", !endDisabled("16:30"));
ok("cannot reach past the next rule", endDisabled("16:35"));

console.log("\nextending the LATER rule's start (→ 16:30–19:00)");
ok("cannot shrink it", startDisabled("17:00"));
ok("cannot pick the time it already starts", startDisabled("16:30"));
ok("can grow back into the hole", !startDisabled("15:10"));
ok("can close the hole exactly", !startDisabled("14:30"));
ok("cannot reach back over the earlier rule", startDisabled("14:00"));

console.log("\na brand new rule");
ok("a time inside an existing rule is greyed", insideBusy("09:00"));
ok("...and inside the later one too", insideBusy("18:00"));
ok("a time in the hole is free", !insideBusy("15:10"));
// Half-open windows: a rule may start exactly where another ends, and they will
// never both be on duty, so the handover minutes must stay selectable.
ok("the minute one rule ENDS is still free", !insideBusy("14:30"));
ok("the minute the next rule STARTS is still free", !insideBusy("16:30"));
ok("a time before the day's cover begins is free", !insideBusy("06:00"));
ok("a time after it ends is free", !insideBusy("20:00"));

console.log("\nan overnight rule wraps midnight");
{
  const night: [string, string][] = [["22:00", "06:00"]];
  const inNight = (t: string) => {
    const m = toMin(t);
    return night.some(([f, e]) => {
      const a = toMin(f), b = toMin(e);
      return a < b ? m > a && m < b : m > a || m < b;
    });
  };
  ok("02:00 is taken", inNight("02:00"));
  ok("23:00 is taken", inNight("23:00"));
  ok("12:00 is free", !inNight("12:00"));
  ok("the 06:00 handover is free", !inNight("06:00"));
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
