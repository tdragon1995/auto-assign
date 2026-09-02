/**
 * Which leave row a delete click actually removes.
 *
 * The dashboard hands over a driver, a start date and a window — never a row
 * number, because the Nghỉ phép tab moves under a panel that is minutes old.
 * Everything that decides WHICH line disappears therefore happens against a
 * fresh read of the sheet, and it is the part worth pinning: a leave row is not
 * recoverable from the app, and the sheet routinely holds several rows that all
 * answer to the same driver + date + window.
 *
 * Three rules, each with a live failure behind it:
 *
 *   1. the UNCOVERED copy goes first. The duplicate pair the panel already flags
 *      is one row a requester typed and one a supervisor filled cover into;
 *      taking the covered one out loses the substitute and nothing says so.
 *   2. one row per click. Deleting the whole matching set on one press would
 *      take the record with the duplicate.
 *   3. a split-shift day is TWO rows with two windows, and the window is part of
 *      the identity — deleting "the 06:00–15:00 one" must never hit the
 *      15:00–20:00 one that hands over to the other substitute.
 *
 * Pure logic — no Google client, no network:
 *
 *   npx tsx scripts/leave-row-delete.test.mts
 */

import { matchLeaveRows, pickLeaveRowToDelete } from "../src/lib/sheets-writer";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (label: string, got: unknown, want: unknown) =>
  check(label, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const HEADER = [
  "timestamp", "driver_id", "driver", "Loại Nghỉ", "leave_from", "leave_to",
  "leave_from_hr", "leave_to_hr", "sub1_id", "sub1_name", "sub2_name", "note",
];
const SON = "id-son";
const OTHER = "id-other";

/** A sheet row in HEADER order; unnamed fields default to blank. */
function row(o: Partial<Record<string, string>>): string[] {
  return HEADER.map((h) => o[h] ?? "");
}

const col: Record<string, number> = {};
HEADER.forEach((h, i) => { col[h] = i; });

/** Which 1-based sheet rows a delete request matches, and which one it takes. */
const matches = (all: string[][], m: { driver_id: string; leave_from: string; timeLabel: string | null }) =>
  matchLeaveRows(all, col, m).map((c) => c.row);
const victim = (all: string[][], m: { driver_id: string; leave_from: string; timeLabel: string | null }) =>
  pickLeaveRowToDelete(matchLeaveRows(all, col, m))?.row ?? null;

// ── Identity ────────────────────────────────────────────────────────────────
console.log("finding the row the dashboard means");
{
  const sheet = [
    HEADER,
    row({ driver_id: OTHER, driver: "Ai đó", leave_from: "2026-09-04", leave_to: "2026-09-04" }), // 2
    row({ driver_id: SON, driver: "Sơn", leave_from: "2026-09-04", leave_to: "2026-09-04" }),     // 3
    row({ driver_id: SON, driver: "Sơn", leave_from: "2026-09-05", leave_to: "2026-09-05" }),     // 4
  ];
  eq("the driver's own full-day row", matches(sheet, { driver_id: SON, leave_from: "2026-09-04", timeLabel: null }), [3]);
  eq("another driver's identical day is untouched", matches(sheet, { driver_id: OTHER, leave_from: "2026-09-04", timeLabel: null }), [2]);
  eq("a date nobody is off on matches nothing", matches(sheet, { driver_id: SON, leave_from: "2026-09-06", timeLabel: null }), []);
  eq("nothing to delete answers null", victim(sheet, { driver_id: SON, leave_from: "2026-09-06", timeLabel: null }), null);
}

// The sheet's date cells come back in whatever the cell's locale formatting
// gives — a d/m/yyyy row must still be findable from the ISO date the API serves.
{
  const sheet = [
    HEADER,
    row({ driver_id: OTHER, driver: "Ai đó", leave_from: "2026-01-01" }),
    row({ driver_id: SON, driver: "Sơn", leave_from: "4/9/2026", leave_to: "4/9/2026" }), // 3
  ];
  eq("a d/m/yyyy cell still matches the ISO request",
    matches(sheet, { driver_id: SON, leave_from: "2026-09-04", timeLabel: null }), [3]);
}

// ── Windows are part of the identity ────────────────────────────────────────
console.log("telling a split-shift day's two rows apart");
{
  const sheet = [
    HEADER,
    row({ driver_id: OTHER, driver: "Ai đó", leave_from: "2026-01-01" }),
    row({ driver_id: SON, driver: "Sơn", leave_from: "2026-09-04", leave_from_hr: "06:00", leave_to_hr: "15:00", sub1_name: "A" }), // 3
    row({ driver_id: SON, driver: "Sơn", leave_from: "2026-09-04", leave_from_hr: "15:00", leave_to_hr: "20:00", sub1_name: "B" }), // 4
  ];
  eq("the morning window", matches(sheet, { driver_id: SON, leave_from: "2026-09-04", timeLabel: "06:00–15:00" }), [3]);
  eq("the afternoon window", matches(sheet, { driver_id: SON, leave_from: "2026-09-04", timeLabel: "15:00–20:00" }), [4]);
  eq("a full-day request matches neither windowed row",
    matches(sheet, { driver_id: SON, leave_from: "2026-09-04", timeLabel: null }), []);
  eq("the sheet's 6:00 and the panel's 06:00 are the same window",
    matches([HEADER, sheet[1], row({ driver_id: SON, driver: "Sơn", leave_from: "2026-09-04", leave_from_hr: "6:00", leave_to_hr: "15:00" })],
      { driver_id: SON, leave_from: "2026-09-04", timeLabel: "06:00–15:00" }), [3]);
}

// ── Choosing between identical rows ─────────────────────────────────────────
console.log("choosing between identical rows");
{
  // The pair the panel flags as "Trùng dòng": one blank, one with cover on it.
  const sheet = [
    HEADER,
    row({ driver_id: OTHER, driver: "Ai đó", leave_from: "2026-01-01" }),
    row({ driver_id: SON, driver: "Sơn", leave_from: "2026-09-04", sub1_id: "id-a", sub1_name: "A" }), // 3 — the record
    row({ driver_id: SON, driver: "Sơn", leave_from: "2026-09-04" }),                                  // 4 — the copy
  ];
  eq("both rows are found", matches(sheet, { driver_id: SON, leave_from: "2026-09-04", timeLabel: null }), [3, 4]);
  eq("the uncovered copy is the one that goes", victim(sheet, { driver_id: SON, leave_from: "2026-09-04", timeLabel: null }), 4);
}
{
  // Same, with the blank row appended FIRST — order on the sheet must not decide it.
  const sheet = [
    HEADER,
    row({ driver_id: OTHER, driver: "Ai đó", leave_from: "2026-01-01" }),
    row({ driver_id: SON, driver: "Sơn", leave_from: "2026-09-04" }),                                  // 3 — the copy
    row({ driver_id: SON, driver: "Sơn", leave_from: "2026-09-04", sub1_id: "id-a", sub1_name: "A" }), // 4 — the record
  ];
  eq("cover wins wherever it sits", victim(sheet, { driver_id: SON, leave_from: "2026-09-04", timeLabel: null }), 3);
}
{
  // Nothing to choose between them — take the newest, i.e. what a re-push added.
  const sheet = [
    HEADER,
    row({ driver_id: OTHER, driver: "Ai đó", leave_from: "2026-01-01" }),
    row({ driver_id: SON, driver: "Sơn", leave_from: "2026-09-04" }), // 3
    row({ driver_id: SON, driver: "Sơn", leave_from: "2026-09-04" }), // 4
    row({ driver_id: SON, driver: "Sơn", leave_from: "2026-09-04" }), // 5
  ];
  eq("ties take the last-appended row", victim(sheet, { driver_id: SON, leave_from: "2026-09-04", timeLabel: null }), 5);
  eq("all three are found…", matches(sheet, { driver_id: SON, leave_from: "2026-09-04", timeLabel: null }), [3, 4, 5]);
  check("…and exactly one is nominated — a set is cleared one click at a time",
    typeof victim(sheet, { driver_id: SON, leave_from: "2026-09-04", timeLabel: null }) === "number");
}

// ── What comes back with the deletion ───────────────────────────────────────
console.log("reporting what went");
{
  const sheet = [
    HEADER,
    row({ driver_id: OTHER, driver: "Ai đó", leave_from: "2026-01-01" }),
    row({
      driver_id: SON, driver: "F - C - DC100777 Nguyễn Hồng Sơn", "Loại Nghỉ": "Nghỉ nguyên buổi",
      leave_from: "2026-09-04", leave_to: "2026-09-06", note: "MISA auto 2026-09-02 08:15",
    }),
  ];
  const c = pickLeaveRowToDelete(matchLeaveRows(sheet, col, { driver_id: SON, leave_from: "2026-09-04", timeLabel: null }))!;
  eq("the span is reported, so a 3-day row cannot vanish unnoticed", [c.leave_from, c.leave_to], ["2026-09-04", "2026-09-06"]);
  eq("the note comes back, so a MISA-derived row is recognisable", c.note, "MISA auto 2026-09-02 08:15");
  eq("so does the sheet's own driver label", c.driver_name, "F - C - DC100777 Nguyễn Hồng Sơn");
}

console.log(failures === 0 ? "\nAll leave-row-delete checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
