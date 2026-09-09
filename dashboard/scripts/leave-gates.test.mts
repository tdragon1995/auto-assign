/**
 * The two questions the CONFIG answers about a leave row.
 *
 * Both used to be answered by a clock or not at all, and both are the kind of
 * wrong that never shows up as an error — a row that should not exist, or a
 * driver double-booked on a day everyone thought was covered.
 *
 * 1. DOES THE DAY OFF REACH THE PART-TIME TWIN? It used to be noon: a half-day
 *    ending after twelve reached the twin, one ending before it did not. That
 *    reads the wrong thing in both directions. "06:00–13:00" means back at one —
 *    the person works the afternoon and the evening — and the clock filed the
 *    twin off until 23:59, marking a working evening absent. And a PT account
 *    rostered 06:00–10:00 got nothing for a morning absence that plainly covers
 *    it. The config knows; a clock cannot.
 *
 * 2. IS THE SUBSTITUTE ALREADY BUSY? Naming B to cover A says nothing about B's
 *    own branches, and B usually has some. The sheet, the engine and the panel
 *    all accept the pairing; the day fails on the road.
 *
 * Both are pure functions over parsed mapping rows, which is the only way to
 * test them — the live config changes hourly and neither answer may depend on
 * what it happens to say today.
 *
 *   npx tsx scripts/leave-gates.test.mts
 */

import { configDutyBlocks, companionNeeded } from "../src/lib/pt-companion";
import { busyBranches, subDutyWarning, parseWindowLabel } from "../src/lib/sub-duty";
import type { Mapping } from "../src/lib/types";

let failures = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}\n         got  ${g}\n         want ${w}`); }
};

const hm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return { hours: h, minutes: m };
};

/** A config row: who drives what, between when and when. */
const row = (over: Partial<Mapping> & { customer_id: string }): Mapping => ({
  driver_id: "", smart_driver_id: [], dropoff_id: "", first_name_last_name: "",
  shift_start: null, shift_end: null, bot_token: "", chat_id: "", alt_drop_off_id: "",
  ...over,
});

const PT = "uuid-pt";
const evening = row({ customer_id: "D014", driver_id: PT, shift_start: hm("17:00"), shift_end: hm("21:00") });
const morningPt = row({ customer_id: "D021", driver_id: PT, shift_start: hm("06:00"), shift_end: hm("10:00") });
const allDay = row({ customer_id: "D030", driver_id: PT });
const someoneElse = row({ customer_id: "D009", driver_id: "uuid-other", shift_start: hm("17:00"), shift_end: hm("21:00") });

// --- 1. does the day off reach the twin? --------------------------------------

console.log("finding the twin's own hours");
eq("a fixed row is duty", configDutyBlocks(PT, [evening]), [[1021, 1260]]);
eq("so is being one candidate on a smart row — that list is what smart-assign ranks",
  configDutyBlocks(PT, [row({ customer_id: "D001", smart_driver_id: ["x", PT], shift_start: hm("17:00"), shift_end: hm("21:00") })]),
  [[1021, 1260]]);
eq("a blank shift is the whole day", configDutyBlocks(PT, [allDay]), [[0, 1439]]);
eq("someone else's rows are not this driver's hours", configDutyBlocks(PT, [someoneElse]), []);
eq("no id at all matches nothing", configDutyBlocks("", [evening]), []);

console.log("a whole day off");
eq("reaches a twin who is in the config", companionNeeded(null, configDutyBlocks(PT, [evening])), true);
// The point of the whole gate: a PT account nobody gives work to does not need
// a day off, and every row written for one is a row somebody has to read.
eq("does NOT reach a twin with no config rows at all",
  companionNeeded(null, configDutyBlocks(PT, [someoneElse])), false);

console.log("a half day off");
const ptEvening = configDutyBlocks(PT, [evening]);
// The case that started this: a morning absence, back at one, evening worked.
eq("06:00–13:00 does NOT reach an evening rule — they are back for it",
  companionNeeded({ start: "06:00", end: "13:00" }, ptEvening), false);
eq("nor does 06:00–11:00", companionNeeded({ start: "06:00", end: "11:00" }, ptEvening), false);
// By the HOUR: 17:00 is the 17th hour on both sides, so this counts. A rule
// that answered differently for 16:59 and 17:00 is one nobody can predict, and
// shift boundaries here are hand-typed and drift between rows.
eq("13:00–17:00 DOES — they share the 17th hour",
  companionNeeded({ start: "13:00", end: "17:00" }, ptEvening), true);
eq("13:00–18:00 does too", companionNeeded({ start: "13:00", end: "18:00" }, ptEvening), true);
eq("13:00–16:59 does NOT — the hours stop one short",
  companionNeeded({ start: "13:00", end: "16:59" }, ptEvening), false);
eq("and a leave running to the end of the day plainly does",
  companionNeeded({ start: "13:00", end: "23:59" }, ptEvening), true);
// The other direction the clock got wrong.
eq("a MORNING absence reaches a MORNING part-time rule",
  companionNeeded({ start: "06:00", end: "11:00" }, configDutyBlocks(PT, [morningPt])), true);
eq("an all-day rule is reached by any window",
  companionNeeded({ start: "06:00", end: "11:00" }, configDutyBlocks(PT, [allDay])), true);

console.log("windows that say nothing");
eq("an unusable window is not a config question — the engine ignores the row too",
  companionNeeded({ start: "", end: "" }, ptEvening), false);
eq("a backwards window likewise", companionNeeded({ start: "18:00", end: "08:00" }, ptEvening), false);
eq("a zero-length window likewise", companionNeeded({ start: "13:00", end: "13:00" }, ptEvening), false);

console.log("no single minute decides it");
// The whole point of comparing hours: these three are the same answer, where a
// minute-exact rule made the first differ from the other two.
eq("ending at 17:00 counts", companionNeeded({ start: "12:00", end: "17:00" }, ptEvening), true);
eq("ending at 17:01 counts", companionNeeded({ start: "12:00", end: "17:01" }, ptEvening), true);
eq("ending at 17:59 counts", companionNeeded({ start: "12:00", end: "17:59" }, ptEvening), true);
// And the hour before is still outside, so it has not become "always yes".
eq("ending at 16:30 does not", companionNeeded({ start: "12:00", end: "16:30" }, ptEvening), false);

// --- 2. is the substitute already busy? ---------------------------------------

const SUB = "uuid-sub";
const subMorning = row({ customer_id: "D007", driver_id: SUB, shift_start: hm("06:00"), shift_end: hm("12:00") });
const subAfternoon = row({ customer_id: "D016", driver_id: SUB, shift_start: hm("12:00"), shift_end: hm("19:00") });
const subSmart = row({ customer_id: "D033", smart_driver_id: [SUB], shift_start: hm("06:00"), shift_end: hm("19:00") });

console.log("the substitute's own branches");
eq("named when the hours meet", busyBranches(SUB, { start: "13:00", end: "17:00" }, [subAfternoon]), ["D016"]);
eq("not named when they do not", busyBranches(SUB, { start: "13:00", end: "17:00" }, [subMorning]), []);
// Otherwise the warning fires on nearly every substitute ever named, and a
// warning that always fires is one nobody reads.
eq("a SMART row is not a duty — it is one candidate among several",
  busyBranches(SUB, { start: "13:00", end: "17:00" }, [subSmart]), []);
eq("a whole-day leave meets everything they run", busyBranches(SUB, null, [subMorning, subAfternoon]),
  ["D007", "D016"]);
eq("one branch is named once, however many rows it has",
  busyBranches(SUB, null, [subAfternoon, row({ customer_id: "D016", driver_id: SUB, shift_start: hm("19:00"), shift_end: hm("21:00") })]),
  ["D016"]);

console.log("the sentence");
const sub = (over: Partial<{ name: string; driver_id: string; from: string | null; to: string | null }> = {}) =>
  ({ name: "F - C - DC100777 Trần Văn Một", driver_id: SUB, from: null, to: null, ...over });
eq("silent when the substitute is free",
  subDutyWarning([sub()], { start: "13:00", end: "17:00" }, [subMorning]), null);
// A count, not a list: customer_id is a Cartrack uuid, so naming them would
// print forty of those and say less than the number does.
eq("names the person and how many routes when they are not",
  subDutyWarning([sub()], { start: "13:00", end: "17:00" }, [subAfternoon, subSmart]),
  "Người thay cũng đang có tuyến cố định trong khung giờ này: Trần Văn Một (1 tuyến). " +
  "Cần bố trí người thay cho chính họ, hoặc kiểm tra lại giờ.");
// A sub given their own window covers only that slice, which is what the sheet
// means by filling sub#_from/sub#_to.
eq("a sub's OWN window is what gets checked, not the leave's",
  subDutyWarning([sub({ from: "06:00", to: "10:00" })], { start: "13:00", end: "17:00" }, [subAfternoon]), null);
eq("nobody to warn about is null", subDutyWarning([], null, [subAfternoon]), null);

console.log("reading a window off a row");
eq("the en dash the sheet reader builds", parseWindowLabel("06:30–15:00"), { start: "06:30", end: "15:00" });
eq("a hand-typed hyphen too", parseWindowLabel("06:30-15:00"), { start: "06:30", end: "15:00" });
eq("a whole day has no window", parseWindowLabel(null), null);
eq("and neither has a backwards one", parseWindowLabel("15:00–06:30"), null);

console.log(failures === 0 ? "\nAll passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
