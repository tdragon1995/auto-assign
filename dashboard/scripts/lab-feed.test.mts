/**
 * The lab's feed: which trips D001 sees, and the note shown on each.
 *
 * Worth pinning because both halves fail SILENTLY and in opposite directions. The
 * filter is a regex over a customer NAME — Cartrack has no field saying what kind of
 * place a customer is — so a client legitimately named "3PLUS" would vanish from the
 * lab's screen with nothing to say why, and a chấm-công tap (one stop, type 3, no
 * pickup at all) would appear as a trip if the "has a pickup" test were dropped.
 * The note is the driver's only free-text field and is empty on most trips until the
 * stop is completed, so "" and "   " must read as no note rather than as an empty line.
 *
 *   npx tsx scripts/lab-feed.test.mts
 */
import type { Job } from "../src/lib/types";
const { isClientPickupJob } = await import("../src/lib/job-filters");
const { notesOf, cleanNote, isNoSample } = await import("../src/lib/stop-notes");

let failed = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) return console.log(`  ok   ${label}`);
  failed++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
}
const eq = (label: string, got: unknown, want: unknown) =>
  ok(label, JSON.stringify(got) === JSON.stringify(want),
    `got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);

/** A two-stop trip, pickup named `from`. Notes are (todo_type_id 5) values per stop. */
const trip = (from: string, pNote?: string, dNote?: string): Job => ({
  job_id: 1,
  stops: [
    { stop_type_id: 1, customer_name: from, todos: pNote === undefined ? [] : [{ todo_type_id: 5, note: pNote }] },
    { stop_type_id: 2, customer_name: "BRA - D001", todos: dNote === undefined ? [] : [{ todo_type_id: 5, note: dNote }] },
  ],
}) as Job;

console.log("\nwhich trips the lab sees");
ok("a client pickup is kept", isClientPickupJob(trip("50873452 - D3 - NDChieu - PHÒNG KHÁM AN KHANG")));
ok("a send-out lab is kept", isClientPickupJob(trip("SENDOUT29 - D10 - HHao - MEDIC")));
ok("a branch run is dropped", !isClientPickupJob(trip("BRA - D023")));
ok("a 3PL handoff is dropped", !isClientPickupJob(trip("3PL - TOT3 - Q5")));
ok("case and spacing don't rescue a branch", !isClientPickupJob(trip(" bra - D007")));
// \b after the literal, so the rule reads "the segment IS BRA/3PL", not "starts with".
ok("a client whose name merely starts with those letters is kept",
  isClientPickupJob(trip("3PLUS Clinic - D1 - LDuan - PK 3PLUS")));
ok("BRACO is a client, not a branch", isClientPickupJob(trip("BRACO - D3 - NTMKhai - BRACO")));
ok("a chấm-công tap is not a trip", !isClientPickupJob({
  job_id: 2, stops: [{ stop_type_id: 3, customer_name: "BRA - D001" }],
} as Job));
ok("a job with no stops at all is not a trip", !isClientPickupJob({ job_id: 3 } as Job));

console.log("\nthe note on a card");
eq("both ends", notesOf(trip("client", "Bảo 2 ống đỏ", "Trúc 2 ống đỏ")), { p: "Bảo 2 ống đỏ", d: "Trúc 2 ống đỏ" });
eq("dropoff only", notesOf(trip("client", undefined, "phuc")), { d: "phuc" });
eq("no todos at all", notesOf(trip("client")), null);
eq("an empty note is no note", notesOf(trip("client", "", "")), null);
eq("a whitespace note is no note", notesOf(trip("client", "   ")), null);
eq("a note is trimmed", notesOf(trip("client", "  Hân 2 mẫu  ")), { p: "Hân 2 mẫu" });

console.log("\nnotes typed with the return key");
// Everywhere else on the feed the first word is WHO, so a name typed last has to be
// hoisted or the reader's learned scan takes "1" for the name.
eq("a trailing name is hoisted to the front", cleanNote("1 đỏ \n1 lọ \nDung"), "Dung, 1 đỏ, 1 lọ");
eq("a leading name is left where it is", cleanNote("Dung\n1 đỏ"), "Dung, 1 đỏ");
eq("a trailing segment with a digit is not a name", cleanNote("Dung\n2 ống đỏ"), "Dung, 2 ống đỏ");
eq("a long trailing phrase is not a name", cleanNote("2 đỏ\ngiao tại quầy lễ tân tầng trệt"), "2 đỏ, giao tại quầy lễ tân tầng trệt");
eq("a single line passes through", cleanNote("Bảo 2 ống đỏ"), "Bảo 2 ống đỏ");

console.log("\ntrips that collected nothing");
ok("K mẫu", isNoSample({ p: "K mẫu" }));
ok("không có mẫu, with a time appended", isNoSample({ p: "Không có mẫu 11h29" }));
ok("ko mau, unaccented", isNoSample({ p: "ko mau" }));
ok("only the dropoff says it", isNoSample({ d: "k mẫu" }));
// The words have to START the note: a handover that merely mentions a missing tube
// type is a real delivery and must never read as an empty trip.
ok("a note that mentions it mid-sentence is a real handover", !isNoSample({ p: "Bảo không có mẫu tím, 2 đỏ" }));
ok("an ordinary note is not an empty trip", !isNoSample({ p: "Bảo 2 ống đỏ", d: "Trúc 2 ống đỏ" }));
ok("nothing at all is not the empty-trip state", !isNoSample({}));

console.log(failed ? `\n${failed} FAILED\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
