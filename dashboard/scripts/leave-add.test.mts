/**
 * Filing leave from the dashboard.
 *
 * The panel could already repair a leave row (substitute, delete) but not
 * CREATE one — that was the driver's own form or a hand-typed sheet row. The
 * form now posts the same payloads the driver's form posts, to the same
 * `/api/nghi-phep`, so everything downstream (the duplicate check, the sheet's
 * formula columns, the suppression rule) is untouched.
 *
 * Which leaves two things that can go quietly wrong, and they are what is
 * tested here.
 *
 * THE SHAPE OF EACH PAYLOAD. Three leave types share one form state and each
 * reads a different subset of it:
 *
 *   1. LEAKED FIELDS. Pick "nửa buổi", set an hour window, change your mind and
 *      pick "nguyên buổi": the hours are still in state. Sending them writes a
 *      window onto a whole-day row, which the engine honours as a partial day —
 *      the driver is given work on a day they are off, and the row looks correct
 *      to anyone reading the sheet.
 *   2. THE DRIVER ID. The sheet's driver_id column is an xlookup on the name, so
 *      a name that is not on the roster produces a row the engine cannot see at
 *      all — invisible leave, the worst outcome this form has.
 *
 * AND THE REGROUPING OF DAYS, which is new here. Days are a SET (Monday and
 * Thursday off is not Monday-to-Thursday), and the set is regrouped into
 * consecutive runs so a week off costs one request rather than seven. That is
 * quiet in both directions: merging across a gap BOOKS A DAY THE DRIVER IS
 * WORKING, and failing to merge only wastes requests. A half-day never merges
 * at all — a multi-day row repeats its hours on every day of the span, which is
 * the shape the panel already flags as a thing to split.
 *
 * Plus the range cap: one sheet row per day, so a mistyped year is hundreds of
 * appends, and the route enforces the same bound.
 *
 *   npx tsx scripts/leave-add.test.mts
 */

import {
  buildLeaveSubmission, groupConsecutive, expandRange, normalizeDays,
  findPtTwin, ptCompanionOf, EMPTY_LEAVE_FORM, MAX_LEAVE_DAYS,
  type NewLeaveForm, type LeavePayload, type SubWrite,
} from "../src/components/leave-status-panel";
import type { ConfigDriver } from "../src/lib/types";

let failures = 0;
/** Key order is not part of any of these contracts — a payload built by
 *  spreading a base reads the same as one built field by field — so it is not
 *  allowed to fail an assertion either. */
const stable = (v: unknown) =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
const eq = (label: string, got: unknown, want: unknown) => {
  const g = stable(got), w = stable(want);
  if (g === w) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}\n         got  ${g}\n         want ${w}`); }
};

// Two people. SOLO holds one account, so his rows are the payload shape on its
// own; HUNG holds both a full-time and a part-time account, which is the pairing
// the twin section is about. Most cases below use SOLO deliberately — a shape
// assertion should not also be asserting the twin rule.
const SOLO: ConfigDriver = { driver_id: "uuid-solo", name: "F - C - DC100777 Trần Văn Một" };
const HUNG_FT: ConfigDriver = { driver_id: "uuid-hung", name: "F - C - DC100320 Lý Chánh Hùng" };
const HUNG_PT: ConfigDriver = { driver_id: "uuid-hung-pt", name: "P - C - PT100321 Lý Chánh Hùng" };
const DRIVERS: ConfigDriver[] = [SOLO, HUNG_FT, HUNG_PT];
const HUNG = SOLO.name;
const BASE = { driver_id: "uuid-solo", driver_name: SOLO.name, note: "Nhập từ dashboard" };

const form = (over: Partial<NewLeaveForm>): NewLeaveForm => ({ ...EMPTY_LEAVE_FORM, ...over });

/** The payloads, or the string "ERROR: …" — so a case that was meant to build
 *  and instead refused reads as a diff rather than as a thrown test. */
const build = (over: Partial<NewLeaveForm>): LeavePayload[] | string => {
  const r = buildLeaveSubmission(form(over), DRIVERS);
  return "error" in r ? `ERROR: ${r.error}` : r.payloads;
};
/** The substitute half of the same call. */
const subs = (over: Partial<NewLeaveForm>): SubWrite[] | string => {
  const r = buildLeaveSubmission(form(over), DRIVERS);
  return "error" in r ? `ERROR: ${r.error}` : r.subWrites;
};
const errored = (over: Partial<NewLeaveForm>): boolean => typeof build(over) === "string";

// --- 1. the three shapes, each complete ---------------------------------------

console.log("whole day");
eq("one day sends the same date at both ends — the sheet stores from and to",
  build({ name: HUNG, loai_nghi: "nguyen_buoi", days: ["2026-09-10"] }),
  [{ ...BASE, loai_nghi: "nguyen_buoi", ngay_bat_dau: "2026-09-10", ngay_ket_thuc: "2026-09-10" }]);

eq("a run becomes ONE request carrying both ends",
  build({ name: HUNG, loai_nghi: "nguyen_buoi", days: ["2026-09-10", "2026-09-11", "2026-09-12"] }),
  [{ ...BASE, loai_nghi: "nguyen_buoi", ngay_bat_dau: "2026-09-10", ngay_ket_thuc: "2026-09-12" }]);

console.log("half day");
eq("carries the window, no range end, and ONE request per day",
  build({ name: HUNG, loai_nghi: "nua_buoi", days: ["2026-09-10", "2026-09-11"], start: "13:00", end: "17:30" }),
  [
    { ...BASE, loai_nghi: "nua_buoi", ngay_bat_dau: "2026-09-10", gio_bat_dau: "13:00", gio_ket_thuc: "17:30" },
    { ...BASE, loai_nghi: "nua_buoi", ngay_bat_dau: "2026-09-11", gio_bat_dau: "13:00", gio_ket_thuc: "17:30" },
  ]);

console.log("resignation");
eq("sends the last working day untouched — the route is what shifts it forward",
  build({ name: HUNG, loai_nghi: "nghi_viec", days: ["2026-09-30"] }),
  [{ ...BASE, loai_nghi: "nghi_viec", ngay_bat_dau: "2026-09-30" }]);
eq("more than one date refuses — a person stops working once",
  errored({ name: HUNG, loai_nghi: "nghi_viec", days: ["2026-09-30", "2026-10-01"] }), true);

// --- 2. days that are a SET, not a range --------------------------------------

console.log("regrouping a set of days");
eq("a gap is NOT bridged — the day between is a working day",
  build({ name: HUNG, loai_nghi: "nguyen_buoi", days: ["2026-09-10", "2026-09-12"] }),
  [
    { ...BASE, loai_nghi: "nguyen_buoi", ngay_bat_dau: "2026-09-10", ngay_ket_thuc: "2026-09-10" },
    { ...BASE, loai_nghi: "nguyen_buoi", ngay_bat_dau: "2026-09-12", ngay_ket_thuc: "2026-09-12" },
  ]);
eq("two runs stay two runs",
  groupConsecutive(["2026-09-10", "2026-09-11", "2026-09-14", "2026-09-15"]),
  [{ from: "2026-09-10", to: "2026-09-11" }, { from: "2026-09-14", to: "2026-09-15" }]);
eq("out of order and duplicated still groups as one run",
  groupConsecutive(["2026-09-12", "2026-09-10", "2026-09-11", "2026-09-10"]),
  [{ from: "2026-09-10", to: "2026-09-12" }]);
eq("a month boundary is consecutive",
  groupConsecutive(["2026-08-31", "2026-09-01"]), [{ from: "2026-08-31", to: "2026-09-01" }]);
eq("so is a leap day", groupConsecutive(["2028-02-28", "2028-02-29", "2028-03-01"]),
  [{ from: "2028-02-28", to: "2028-03-01" }]);
eq("a year boundary is consecutive",
  groupConsecutive(["2026-12-31", "2027-01-01"]), [{ from: "2026-12-31", to: "2027-01-01" }]);
eq("nothing groups to nothing", groupConsecutive([]), []);
eq("garbage is dropped rather than grouped", groupConsecutive(["not-a-date", "2026-09-10"]),
  [{ from: "2026-09-10", to: "2026-09-10" }]);

console.log("the day set itself");
eq("sorted and de-duplicated", normalizeDays(["2026-09-12", "2026-09-10", "2026-09-12"]),
  ["2026-09-10", "2026-09-12"]);
eq("a range expands inclusively", expandRange("2026-09-10", "2026-09-12"),
  ["2026-09-10", "2026-09-11", "2026-09-12"]);
eq("a single-day range is one day", expandRange("2026-09-10", "2026-09-10"), ["2026-09-10"]);
eq("a backwards range adds nothing", expandRange("2026-09-12", "2026-09-10"), []);
eq("an absurd range adds nothing rather than a year of chips",
  expandRange("2026-09-10", "2027-09-10"), []);

// --- 3. fields left behind by a change of mind --------------------------------

console.log("stale fields from another leave type");
// The whole point: hours typed under "nửa buổi" are still in state after the
// type changes. A window on a whole-day row is honoured as a partial day.
eq("hours do NOT leak onto a whole-day row",
  build({ name: HUNG, loai_nghi: "nguyen_buoi", days: ["2026-09-10", "2026-09-11"], start: "13:00", end: "17:30" }),
  [{ ...BASE, loai_nghi: "nguyen_buoi", ngay_bat_dau: "2026-09-10", ngay_ket_thuc: "2026-09-11" }]);

eq("nothing leaks onto a resignation either",
  build({ name: HUNG, loai_nghi: "nghi_viec", days: ["2026-09-30"], start: "08:00", end: "12:00" }),
  [{ ...BASE, loai_nghi: "nghi_viec", ngay_bat_dau: "2026-09-30" }]);

// --- 4. the driver ---------------------------------------------------------

console.log("the driver");
eq("nothing picked refuses", errored({ loai_nghi: "nguyen_buoi", days: ["2026-09-10"] }), true);
eq("a name that is not on the roster refuses rather than inventing an id",
  build({ name: "Nguyễn Văn Không Có", loai_nghi: "nguyen_buoi", days: ["2026-09-10"] }),
  "ERROR: Chọn tài xế từ danh sách");
// Two accounts, one person: each is its own leave row, and the id must be the
// one belonging to the label that was picked.
eq("a part-time account resolves to its OWN id, not its full-time twin's",
  (build({ name: HUNG_PT.name, loai_nghi: "nghi_viec", days: ["2026-09-30"] }) as LeavePayload[])[0].driver_id,
  "uuid-hung-pt");
eq("no type picked refuses", errored({ name: HUNG, days: ["2026-09-10"] }), true);

// --- 5. dates and windows ---------------------------------------------------

console.log("dates and the window");
eq("no day picked refuses", errored({ name: HUNG, loai_nghi: "nguyen_buoi", days: [] }), true);
eq("a resignation with no date refuses", errored({ name: HUNG, loai_nghi: "nghi_viec", days: [] }), true);
eq("half day with no hours refuses — an open window would read as the whole day",
  errored({ name: HUNG, loai_nghi: "nua_buoi", days: ["2026-09-10"] }), true);
eq("only a start refuses",
  errored({ name: HUNG, loai_nghi: "nua_buoi", days: ["2026-09-10"], start: "08:00" }), true);
eq("a zero-length window refuses",
  errored({ name: HUNG, loai_nghi: "nua_buoi", days: ["2026-09-10"], start: "08:00", end: "08:00" }), true);
eq("a backwards window refuses",
  errored({ name: HUNG, loai_nghi: "nua_buoi", days: ["2026-09-10"], start: "17:00", end: "08:00" }), true);
// The window is typed, not chosen off a half-hour grid: a person leaves at
// 13:15, and the row has to say 13:15. Nothing may snap it to the nearest slot.
eq("an off-grid window is written exactly as picked",
  (build({ name: HUNG, loai_nghi: "nua_buoi", days: ["2026-09-10"], start: "13:15", end: "17:42" }) as LeavePayload[])[0],
  { ...BASE, loai_nghi: "nua_buoi", ngay_bat_dau: "2026-09-10", gio_bat_dau: "13:15", gio_ket_thuc: "17:42" });
// Ordering is compared as zero-padded "HH:MM", which is only correct to the
// MINUTE — an hour-only comparison would let this pair through.
eq("a window that runs backwards by minutes alone still refuses",
  errored({ name: HUNG, loai_nghi: "nua_buoi", days: ["2026-09-10"], start: "13:45", end: "13:15" }), true);
eq("one minute forward is a valid window",
  errored({ name: HUNG, loai_nghi: "nua_buoi", days: ["2026-09-10"], start: "13:15", end: "13:16" }), false);

// --- 6. the range cap -------------------------------------------------------

console.log(`the ${MAX_LEAVE_DAYS}-day cap (one sheet row per day)`);
/** n consecutive days from `from`. Built here rather than with expandRange,
 *  which caps itself — the point of these cases is to exceed the cap. */
const run = (from: string, n: number) =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
eq("exactly the cap is accepted",
  errored({ name: HUNG, loai_nghi: "nguyen_buoi", days: run("2026-09-01", MAX_LEAVE_DAYS) }), false);
eq("one day past it refuses",
  errored({ name: HUNG, loai_nghi: "nguyen_buoi", days: run("2026-09-01", MAX_LEAVE_DAYS + 1) }), true);
eq("the cap counts DAYS, not requests — 32 scattered days still refuse",
  errored({
    name: HUNG, loai_nghi: "nua_buoi", start: "08:00", end: "12:00",
    days: run("2026-09-01", MAX_LEAVE_DAYS + 1),
  }), true);

// --- 8. the part-time twin ---------------------------------------------------
//
// About a dozen people hold both a DC… and a PT… account and switch to the
// second for a trip running past their own shift, so a day off filed against
// only the full-time account leaves the twin reading as available all evening.
// The MISA sync already files the twin; a day typed on the dashboard has to do
// the same or this form is the one door that produces a half-recorded absence.
//
// The failure that matters is the OPPOSITE one, which is why most rules below
// are refusals: filing a day off on the wrong person's account takes a WORKING
// driver off the road, silently, and nothing on the page would say so.

console.log("finding the twin");
eq("one part-time account with the same name is the twin",
  findPtTwin(HUNG_FT, DRIVERS).twin?.driver_id, "uuid-hung-pt");
eq("a part-time account has no twin to find",
  findPtTwin(HUNG_PT, DRIVERS).reason, "not-full-time");
eq("accents and the code prefix do not stop the match — the names are folded",
  findPtTwin(HUNG_FT, [HUNG_FT, { driver_id: "b", name: "P - P - PT100321 Ly Chanh Hung" }]).twin?.driver_id,
  "b");
// Vietnamese names repeat. Picking either of two would book a day off on
// someone who is working.
eq("TWO part-time namesakes resolve to nothing, not to the first",
  findPtTwin(HUNG_FT, [...DRIVERS, { driver_id: "other-pt", name: "P - P - PT100999 Lý Chánh Hùng" }]).reason,
  "ambiguous");
eq("no part-time namesake is simply none", findPtTwin(SOLO, DRIVERS).reason, "none");
eq("a different person's part-time account is not a twin",
  findPtTwin(SOLO, [SOLO, HUNG_PT]).reason, "none");

console.log("what reaches the twin");
const HBASE = { driver_id: "uuid-hung", driver_name: HUNG_FT.name, note: "Nhập từ dashboard" };
const TBASE = {
  driver_id: "uuid-hung-pt", driver_name: HUNG_PT.name,
  note: "Nhập từ dashboard — theo tài khoản FT",
  // The flag is the whole contract with the server: it says "this row is
  // derived", and the server decides — against the config — whether it is
  // written and rewrites a half day's end once it is. See
  // `scripts/leave-gates.test.mts` for that half.
  pt_companion: true,
};
const own = (over: Partial<LeavePayload>): LeavePayload => ({
  ...HBASE, loai_nghi: "nguyen_buoi", ngay_bat_dau: "2026-09-10", ...over,
});

eq("a full day is offered to the twin unchanged",
  ptCompanionOf(own({ ngay_ket_thuc: "2026-09-12" }), HUNG_PT),
  { ...TBASE, loai_nghi: "nguyen_buoi", ngay_bat_dau: "2026-09-10", ngay_ket_thuc: "2026-09-12" });
// The window travels AS ASKED FOR. Rewriting it here to "until the end of the
// day" — which this used to do — destroys the only thing the server's gate can
// judge: those hours overlap every evening rule and let everything through,
// which is the bug the gate exists to fix. The rewrite happens on the server,
// after the gate has passed.
eq("an afternoon half day carries its own hours, for the server to judge",
  ptCompanionOf(own({ loai_nghi: "nua_buoi", gio_bat_dau: "13:00", gio_ket_thuc: "18:00" }), HUNG_PT),
  { ...TBASE, loai_nghi: "nua_buoi", ngay_bat_dau: "2026-09-10", gio_bat_dau: "13:00", gio_ket_thuc: "18:00" });
eq("so does a window straddling noon",
  ptCompanionOf(own({ loai_nghi: "nua_buoi", gio_bat_dau: "08:00", gio_ket_thuc: "15:00" }), HUNG_PT)?.gio_ket_thuc,
  "15:00");
// And a MORNING one is offered rather than dropped: a part-time account
// rostered 06:00–10:00 is missed by a morning absence, which the clock this
// replaced could never see. Whether it is written is the config's answer.
eq("a morning half day is offered too — the config decides, not the hour",
  ptCompanionOf(own({ loai_nghi: "nua_buoi", gio_bat_dau: "08:00", gio_ket_thuc: "12:00" }), HUNG_PT),
  { ...TBASE, loai_nghi: "nua_buoi", ngay_bat_dau: "2026-09-10", gio_bat_dau: "08:00", gio_ket_thuc: "12:00" });
eq("a half day with no usable window copies nothing rather than a guessed one",
  ptCompanionOf(own({ loai_nghi: "nua_buoi", gio_bat_dau: "", gio_ket_thuc: "" }), HUNG_PT), null);
eq("a backwards window copies nothing",
  ptCompanionOf(own({ loai_nghi: "nua_buoi", gio_bat_dau: "17:00", gio_ket_thuc: "08:00" }), HUNG_PT), null);
// A person can move FROM full-time TO part-time; closing the twin on a guess
// would retire a driver who is still working.
eq("a resignation does NOT close the twin account",
  ptCompanionOf(own({ loai_nghi: "nghi_viec" }), HUNG_PT), null);

console.log("the twin rows inside a whole submission");
eq("a full day off files the person FIRST, then the twin",
  build({ name: HUNG_FT.name, loai_nghi: "nguyen_buoi", days: ["2026-09-10", "2026-09-11"] }),
  [
    { ...HBASE, loai_nghi: "nguyen_buoi", ngay_bat_dau: "2026-09-10", ngay_ket_thuc: "2026-09-11" },
    { ...TBASE, loai_nghi: "nguyen_buoi", ngay_bat_dau: "2026-09-10", ngay_ket_thuc: "2026-09-11" },
  ]);
eq("an afternoon half day over two days offers two twin rows too",
  (build({
    name: HUNG_FT.name, loai_nghi: "nua_buoi",
    days: ["2026-09-10", "2026-09-11"], start: "13:00", end: "17:30",
  }) as LeavePayload[]).map((p) => `${p.driver_id} ${p.ngay_bat_dau} ${p.gio_bat_dau}-${p.gio_ket_thuc}`),
  [
    "uuid-hung 2026-09-10 13:00-17:30", "uuid-hung 2026-09-11 13:00-17:30",
    "uuid-hung-pt 2026-09-10 13:00-17:30", "uuid-hung-pt 2026-09-11 13:00-17:30",
  ]);
eq("only the twin's rows carry the flag — the person's own are not derived",
  (build({ name: HUNG_FT.name, loai_nghi: "nguyen_buoi", days: ["2026-09-10"] }) as LeavePayload[])
    .map((p) => p.pt_companion ?? false), [false, true]);
eq("filing against the PT account itself adds nothing",
  (build({ name: HUNG_PT.name, loai_nghi: "nguyen_buoi", days: ["2026-09-10"] }) as LeavePayload[])
    .map((p) => p.driver_id), ["uuid-hung-pt"]);
eq("a full-timer with no twin still files exactly one row",
  (build({ name: SOLO.name, loai_nghi: "nguyen_buoi", days: ["2026-09-10"] }) as LeavePayload[]).length, 1);
// The cap counts the DAYS the supervisor picked, not the rows that result —
// counting rows would halve how much leave a twin-holder could file at once.
eq("the twin's rows do not count against the day cap",
  errored({ name: HUNG_FT.name, loai_nghi: "nguyen_buoi", days: run("2026-09-01", MAX_LEAVE_DAYS) }), false);


// --- 9. the substitute filed with the leave ----------------------------------
//
// Naming the cover in the same form saves a trip back through "Thêm người thay"
// on every row the leave creates — seven of them for a week off. The write goes
// to the endpoint that editor already uses, so the risk is not the write but
// the ADDRESS: a leave row is identified by driver + start date + window, and
// an identity that matches no row fails as "không tìm thấy dòng nghỉ" AFTER the
// leave is already on the sheet.
//
// The trap is the whole-day range. /api/nghi-phep writes ONE ROW PER DAY across
// it, so Mon–Fri is five rows and five identities; addressing it as the single
// range it was submitted as would cover nothing and say nothing.

console.log("addressing the rows to cover");
eq("no substitute picked writes none", subs({ name: HUNG, loai_nghi: "nguyen_buoi", days: ["2026-09-10"] }), []);
eq("a whole-day RANGE is addressed one row per day, not once for the range",
  subs({ name: HUNG, loai_nghi: "nguyen_buoi", days: ["2026-09-10", "2026-09-11", "2026-09-12"], sub: HUNG_PT.name }),
  ["2026-09-10", "2026-09-11", "2026-09-12"].map((d) => ({
    driver_id: "uuid-solo", leave_from: d, timeLabel: null,
    subs: [{ name: HUNG_PT.name, from: null, to: null }],
  })));
eq("scattered days each get their own",
  (subs({ name: HUNG, loai_nghi: "nguyen_buoi", days: ["2026-09-10", "2026-09-12"], sub: HUNG_PT.name }) as SubWrite[])
    .map((w) => w.leave_from), ["2026-09-10", "2026-09-12"]);
// The window is part of the identity — one day can hold two rows split between
// two substitutes, and the label is what tells them apart. The dash is the EN
// DASH the sheet reader builds; a hyphen matches no windowed row at all.
eq("a half day is addressed by its window, with an en dash",
  subs({ name: HUNG, loai_nghi: "nua_buoi", days: ["2026-09-10"], start: "13:15", end: "17:42", sub: HUNG_PT.name }),
  [{
    driver_id: "uuid-solo", leave_from: "2026-09-10", timeLabel: "13:15–17:42",
    subs: [{ name: HUNG_PT.name, from: null, to: null }],
  }]);
eq("the substitute window is left blank — it inherits the leave's own hours",
  (subs({ name: HUNG, loai_nghi: "nua_buoi", days: ["2026-09-10"], start: "13:00", end: "17:00", sub: HUNG_PT.name }) as SubWrite[])[0]
    .subs[0], { name: HUNG_PT.name, from: null, to: null });

console.log("who may cover");
eq("a resignation takes no substitute — nobody stands in for it",
  subs({ name: HUNG, loai_nghi: "nghi_viec", days: ["2026-09-30"], sub: HUNG_PT.name }), []);
eq("a name that is not on the roster refuses BEFORE the leave is written",
  subs({ name: HUNG, loai_nghi: "nguyen_buoi", days: ["2026-09-10"], sub: "Ai Đó" }),
  "ERROR: Chọn người thay từ danh sách");
eq("a driver cannot cover their own day off",
  subs({ name: HUNG, loai_nghi: "nguyen_buoi", days: ["2026-09-10"], sub: HUNG }),
  "ERROR: Người thay trùng với tài xế đang nghỉ");
// The ids differ, so the endpoint reads this as a different person — while it
// is the same one, off that day, standing in for themselves.
eq("nor their own part-time account, which the endpoint cannot catch",
  subs({ name: HUNG_FT.name, loai_nghi: "nguyen_buoi", days: ["2026-09-10"], sub: HUNG_PT.name }),
  "ERROR: Người thay là tài khoản PT của chính tài xế đang nghỉ");

console.log("the twin is covered separately");
// A substitute covers ONE account. The twin's row is the evening — a different
// question, which the panel has always asked on its own card.
eq("the twin's rows are not addressed by this cover",
  (subs({ name: HUNG_FT.name, loai_nghi: "nguyen_buoi", days: ["2026-09-10"], sub: SOLO.name }) as SubWrite[])
    .map((w) => w.driver_id), ["uuid-hung"]);
eq("and the twin's leave row is still written",
  (build({ name: HUNG_FT.name, loai_nghi: "nguyen_buoi", days: ["2026-09-10"], sub: SOLO.name }) as LeavePayload[])
    .map((p) => p.driver_id), ["uuid-hung", "uuid-hung-pt"]);

console.log(failures === 0 ? "\nAll passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
