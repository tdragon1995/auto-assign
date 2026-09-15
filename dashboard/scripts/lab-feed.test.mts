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
const { isClientPickupJob, isLabWatchedClient, keepOnBranchFeed, LAB_CUSTOMER_ID } = await import("../src/lib/job-filters");
const { notesOf } = await import("../src/lib/stop-notes");

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

console.log("\nwhich trips a branch sees");
{
  const D010 = "9a15e7a4-3d83-11ed-be4e-506b8dbc8dfb";
  const D032 = "17dd37b4-3d9d-11ed-93b6-506b8dbc8dfb";
  // A trip with real ids and a dropoff completion time, which is what "handed over" reads.
  const run = (pickupId: string, pickupName: string, delivered = false, status = 4) => ({
    job_status_id: status,
    stops: [
      { stop_type_id: 1, customer_id: pickupId, customer_name: pickupName },
      { stop_type_id: 2, customer_id: D010, customer_name: "BRA - D010",
        activity_completed_ts: delivered ? "2026-09-14 10:10:00" : null },
    ],
  });
  ok("a client's samples coming in are shown",
    keepOnBranchFeed(D010, run("x", "50873452 - D3 - NDChieu - PHÒNG KHÁM AN KHANG")));
  ok("…and stay shown once delivered, as the day's record",
    keepOnBranchFeed(D010, run("x", "50873452 - D3 - NDChieu - PHÒNG KHÁM AN KHANG", true, 5)));
  // The reason the lab's rule could not simply be copied: a branch's own pickup is a
  // "BRA - " name too, and the client rule alone takes every request it ever made.
  ok("the branch's own request is shown while under way", keepOnBranchFeed(D010, run(D010, "BRA - D010")));
  ok("…and leaves the list once handed over", !keepOnBranchFeed(D010, run(D010, "BRA - D010", true)));
  ok("…or once Cartrack closes the job, even with no dropoff time",
    !keepOnBranchFeed(D010, run(D010, "BRA - D010", false, 5)));
  ok("another branch's run passing through is not shown", !keepOnBranchFeed(D010, run(D032, "BRA - D032")));
  ok("a 3PL handoff arriving is not shown", !keepOnBranchFeed(D010, run("y", "3PL - TOT3 - Q5")));
  // The lab books nothing, so nothing counts as its own request.
  ok("the lab gets clients only, even for a run starting at the lab",
    !keepOnBranchFeed(LAB_CUSTOMER_ID, run(LAB_CUSTOMER_ID, "BRA - D001")));
}

console.log("\nclients the lab follows wherever they go");
// AIH sends to D019 on some runs and D001 on others; the DYM branch in D7 never
// touches D001 at all. Both belong on the lab's feed, so these are matched by ACCOUNT.
ok("a watched account going somewhere else is still the lab's",
  isLabWatchedClient(trip("46069949 - D2 - NHoang - BV Quốc tế Mỹ AIH")));
ok("a watched account with no zone segments", isLabWatchedClient(trip("18513")));
ok("an ordinary client is not watched",
  !isLabWatchedClient(trip("50873452 - D3 - NDChieu - PHÒNG KHÁM AN KHANG")));
// Whole segment, not a prefix — otherwise 18513 drags in every account starting with it.
ok("a longer code starting with a watched one is not watched",
  !isLabWatchedClient(trip("185134 - D3 - NTMKhai - Phòng khám khác")));
ok("a branch is not a watched client", !isLabWatchedClient(trip("BRA - D019")));

console.log("\nthe note on a card");
eq("both ends", notesOf(trip("client", "Bảo 2 ống đỏ", "Trúc 2 ống đỏ")), { p: "Bảo 2 ống đỏ", d: "Trúc 2 ống đỏ" });
eq("dropoff only", notesOf(trip("client", undefined, "phuc")), { d: "phuc" });
eq("no todos at all", notesOf(trip("client")), null);
eq("an empty note is no note", notesOf(trip("client", "", "")), null);
eq("a whitespace note is no note", notesOf(trip("client", "   ")), null);
eq("a note is trimmed", notesOf(trip("client", "  Hân 2 mẫu  ")), { p: "Hân 2 mẫu" });

console.log(failed ? `\n${failed} FAILED\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
