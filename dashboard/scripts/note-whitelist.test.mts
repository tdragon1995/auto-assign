/**
 * A note may only stop holding a job when it is EXACTLY a sentence we have
 * proven harmless, and only while there is still a working day left to do it in.
 *
 * The note gate is the last thing standing between a branch's instruction and a
 * driver being sent without anyone having read it. Widening it is safe only
 * under rules that cannot quietly erode, so they are pinned here:
 *
 *   - the whole note must match; a listed sentence buried inside a longer note
 *     changes nothing, because the surrounding words are the instruction;
 *   - one unlisted note anywhere on the job holds the WHOLE job;
 *   - past the evening cutoff nothing is released — jobs booked at 8pm belong to
 *     tomorrow, and a release now would offer them to a driver already home;
 *   - a caller that only DISPLAYS a note (the "Cần xử lý" panel) sees the gate
 *     exactly as it was before the list existed;
 *   - the "Giao ngay" tick keeps working, and survives normalization;
 *   - a sentence needs three CONSECUTIVE approvals to be proposed, and one
 *     "Hẹn giờ" puts it back to zero — it proves the note changes the job.
 *
 * Offline: no network, no Redis, no clock of its own.
 *
 *   cd dashboard && npx tsx scripts/note-whitelist.test.mts
 */

import {
  normalizeNote,
  isBlockingNote,
  blockingNotes,
  isNoteReleaseHour,
  isNoteApproved,
  NOTE_APPROVED_MARK,
  NOTE_RELEASE_CUTOFF_MIN,
  DAYTIME_NON_BLOCKING,
} from "../src/lib/job-filters";
import { nextLearnEntry, NOTE_LEARN_THRESHOLD, type NoteLearnEntry, type NoteDecision } from "../src/lib/smart-log-kv";

let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${ok ? "" : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

/** A stand-in for the measured list, so these rules are pinned whether or not
 *  the real list has been seeded yet. */
const LIST = new Set(["giao giờ hành chính", "gọi bảo vệ mở cổng"]);

/** Saigon-local Date for today at HH:mm (UTC+7 has no daylight saving). */
const at = (hh: number, mm: number) => new Date(`2026-08-29T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+07:00`);
const NOON = at(12, 0);
const LATE = at(20, 15);

const job = (...notes: (string | null)[]) => ({
  stops: notes.map((note, i) => ({ stop_type_id: i === 0 ? 1 : 2, note })),
});

console.log("\n— normalization —");
check("collapses case, spacing and a trailing full stop",
  normalizeNote("  GIAO  GIỜ   HÀNH CHÍNH. "), "giao giờ hành chính");
check("strips the approved tick",
  normalizeNote(`giao giờ hành chính ${NOTE_APPROVED_MARK}`), "giao giờ hành chính");
check("blank stays blank", normalizeNote("   "), "");
check("keeps accents (they are not noise)",
  normalizeNote("Giao giờ hành chính") === "giao gio hanh chinh", false);

console.log("\n— the whole note must match —");
check("listed sentence releases during the day",
  isBlockingNote("Giao giờ hành chính", { now: NOON, daytimeList: LIST }), false);
check("same sentence with odd spacing and capitals releases",
  isBlockingNote("  GIAO  giờ hành chính.  ", { now: NOON, daytimeList: LIST }), false);
check("listed sentence INSIDE a longer note still holds",
  isBlockingNote("Giao giờ hành chính, hôm nay lấy thêm 2 thùng", { now: NOON, daytimeList: LIST }), true);
check("a note that merely starts with it still holds",
  isBlockingNote("Giao giờ hành chính nhé anh", { now: NOON, daytimeList: LIST }), true);
check("an unlisted sentence holds",
  isBlockingNote("Nhớ lấy mẫu ở tầng 3", { now: NOON, daytimeList: LIST }), true);

console.log("\n— the old behaviour is untouched —");
check("blank note never holds", isBlockingNote("   "), false);
check("null note never holds", isBlockingNote(null), false);
check("Call before delivery never holds, day or night",
  [isBlockingNote("Call before delivery", { now: NOON }), isBlockingNote("Call before delivery", { now: LATE })],
  [false, false]);
check("with no list seeded, every real note still holds",
  isBlockingNote("Giao giờ hành chính", { now: NOON }), true);
check("a display-only caller (no clock) sees the gate as it always was",
  isBlockingNote("Giao giờ hành chính", { daytimeList: LIST }), true);

console.log("\n— the evening cutoff —");
check("cutoff is 19:30", NOTE_RELEASE_CUTOFF_MIN, 19 * 60 + 30);
check("working day releases, evening does not",
  [isNoteReleaseHour(at(6, 0)), isNoteReleaseHour(at(19, 29)), isNoteReleaseHour(at(19, 30)), isNoteReleaseHour(at(23, 0))],
  [true, true, false, false]);
check("a listed sentence still holds an 8pm booking",
  isBlockingNote("Giao giờ hành chính", { now: LATE, daytimeList: LIST }), true);

console.log("\n— a job is only released when EVERY note is listed —");
check("one listed note → nothing holds it",
  blockingNotes(job("Giao giờ hành chính"), { now: NOON, daytimeList: LIST }), []);
check("two listed notes → nothing holds it",
  blockingNotes(job("Giao giờ hành chính", "Gọi bảo vệ mở cổng"), { now: NOON, daytimeList: LIST }), []);
check("one listed + one real → the real one holds the whole job",
  blockingNotes(job("Giao giờ hành chính", "Nhớ lấy mẫu ở tầng 3"), { now: NOON, daytimeList: LIST }),
  ["Nhớ lấy mẫu ở tầng 3"]);
check("held notes come back as the branch typed them, not normalized",
  blockingNotes(job("  Nhớ Lấy Mẫu Ở Tầng 3.  ")), ["Nhớ Lấy Mẫu Ở Tầng 3."]);
check("a job with no notes holds nothing", blockingNotes(job(null, null)), []);

console.log("\n— the Giao ngay tick still works —");
check("tick is recognised on any stop",
  isNoteApproved(job("Nhớ lấy mẫu ở tầng 3", `Gấp ${NOTE_APPROVED_MARK}`)), true);
check("a ticked note is still reported as blocking (the tick bypasses elsewhere)",
  isBlockingNote(`Nhớ lấy mẫu ở tầng 3 ${NOTE_APPROVED_MARK}`, { now: NOON, daytimeList: LIST }), true);
check("a ticked LISTED note normalizes back onto the list",
  isBlockingNote(`Giao giờ hành chính ${NOTE_APPROVED_MARK}`, { now: NOON, daytimeList: LIST }), false);

console.log("\n— the list actually shipped —");
// Everything above uses a stand-in list, so it would keep passing even if the
// real one were empty or wrong. These check the sentences really in the code.
check("a seeded sentence releases during the working day",
  isBlockingNote("KHẨN", { now: NOON }), false);
check("the same sentence with capitals, padding and a full stop releases",
  isBlockingNote("  khẩn.  ", { now: NOON }), false);
check("it still holds after the evening cutoff",
  isBlockingNote("KHẨN", { now: LATE }), true);
check("it does NOT release when it is only the start of a longer note",
  isBlockingNote("Khẩn, lấy trước 3h", { now: NOON }), true);
check("an on-site direction releases",
  isBlockingNote("Cổng 3", { now: NOON }), false);
check("a note naming an hour is NOT on the list",
  [isBlockingNote("19h", { now: NOON }), isBlockingNote("lấy mẫu trước 5 giờ giúp e ạ", { now: NOON })],
  [true, true]);
check("an unlisted instruction still holds",
  isBlockingNote("Nhớ lấy mẫu ở tầng 3", { now: NOON }), true);

console.log("\n— learning from what the supervisor does —");
// Three CLEAN approvals in a row. "Consecutive" is the whole point: a sentence
// that was ever answered with a time has proven it changes the job, and must
// start again from nothing rather than creep over the line on total count.
const run = (decisions: (boolean | "evening")[]) => {
  let e: NoteLearnEntry | undefined;
  for (const d of decisions) {
    const decision: NoteDecision = d === "evening" ? "after-hours" : d ? "approved" : "rescheduled";
    e = nextLearnEntry(e, "Giao giờ hành chính", decision, "2026-08-29 10:00:00") ?? e;
  }
  return e;
};
check("three approvals in a row reach the threshold",
  run([true, true, true])?.ok, NOTE_LEARN_THRESHOLD);
check("two approvals do not",
  (run([true, true])?.ok ?? 0) >= NOTE_LEARN_THRESHOLD, false);
check("a reschedule in the middle puts the run back to zero",
  run([true, true, false, true, true])?.ok, 2);
check("the reschedule is remembered even after later approvals",
  run([true, false, true])?.sched, 1);
check("four approvals after a reschedule still get there",
  (run([true, true, false, true, true, true])?.ok ?? 0) >= NOTE_LEARN_THRESHOLD, true);
check("an accepted sentence stops being counted",
  nextLearnEntry({ ok: 9, sched: 0, sample: "x", last: "", state: "accepted" }, "x", "approved", ""), null);
check("a dismissed sentence stops being counted",
  nextLearnEntry({ ok: 1, sched: 0, sample: "x", last: "", state: "dismissed" }, "x", "approved", ""), null);
check("the sentence is kept as first typed, not as later retyped",
  nextLearnEntry({ ok: 1, sched: 0, sample: "Giao giờ hành chính", last: "" }, "GIAO GIO HANH CHINH", "approved", "")?.sample,
  "Giao giờ hành chính");

check("an evening reschedule does NOT wipe a run — it is about the hour, not the words",
  run([true, true, "evening", true])?.ok, 3);
check("an evening approval does not pad the run either — evening is simply invisible",
  run([true, "evening", "evening"])?.ok, 1);
check("a DAYTIME reschedule still wipes it",
  run([true, true, false, true])?.ok, 1);
check("an evening decision leaves the entry untouched entirely",
  nextLearnEntry({ ok: 2, sched: 0, sample: "x", last: "y" }, "x", "after-hours", "z"), null);

console.log("\n— an accepted sentence joins the shipped list —");
// What the engine does each cycle: the reviewed list, plus whatever has since
// been accepted. Neither replaces the other.
const withLearned = new Set([...DAYTIME_NON_BLOCKING, "gọi bảo vệ mở cổng"]);
check("a newly accepted sentence releases",
  isBlockingNote("Gọi bảo vệ mở cổng", { now: NOON, daytimeList: withLearned }), false);
check("the shipped sentences still release alongside it",
  isBlockingNote("KHẨN", { now: NOON, daytimeList: withLearned }), false);
check("and the evening guard still covers both",
  [isBlockingNote("Gọi bảo vệ mở cổng", { now: LATE, daytimeList: withLearned }),
   isBlockingNote("KHẨN", { now: LATE, daytimeList: withLearned })],
  [true, true]);

console.log(failed === 0 ? "\nAll good.\n" : `\n${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
