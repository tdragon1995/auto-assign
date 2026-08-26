/**
 * Which leave rows get flagged as "spans more than one day".
 *
 * The flag exists because a spanning row does not mean what it looks like it
 * means. `24/08 → 26/08, 06:00–19:00` reads to a human as one continuous
 * absence; the engine reads the hours as a window applied to EVERY day in the
 * span, and reads each substitute's window the same way. Nothing in the app can
 * produce such a row — form leave is written one row per day, half-day is
 * same-day, the MISA push emits one row per charged day — so every one of them
 * was typed by hand and is worth a supervisor's second look.
 *
 * What this pins is the boundary of the flag, because both kinds of mistake are
 * expensive: flagging same-day rows would bury the panel in noise (they are the
 * overwhelming majority), and letting a resignation through would flag a row
 * that is open-ended on purpose, every day, forever.
 *
 * Pure filtering — no Redis, no network, no sheet:
 *
 *   npx tsx scripts/leave-spanning-rows.test.mts
 */

import { spanningLeaveRows, type InvalidLeaveRow, type LeaveEntry } from "../src/lib/leave-config";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` — got ${got}, want ${want}`}`);
}

function entry(p: Partial<LeaveEntry>): LeaveEntry {
  return {
    driver_id: "d1",
    driver_name: "F - P - DC100001 Nguyễn Văn A",
    loai_nghi: "",
    leave_from: "2026-08-25",
    leave_to: "2026-08-25",
    gio_bat_dau: null,
    gio_ket_thuc: null,
    subs: [],
    ...p,
  };
}

const TODAY = "2026-08-25";

console.log("what counts as a spanning row");
const flagged = (e: Partial<LeaveEntry>, from = TODAY) => spanningLeaveRows([entry(e)], [], from).length;

check("same-day row is not flagged", flagged({ leave_from: TODAY, leave_to: TODAY }), 0);
check("blank leave_to is not flagged", flagged({ leave_to: null }), 0);
check("two-day row is flagged", flagged({ leave_from: TODAY, leave_to: "2026-08-26" }), 1);
check(
  "labelled full-day leave spanning two days is flagged too",
  flagged({ loai_nghi: "Nghỉ nguyên buổi", leave_from: TODAY, leave_to: "2026-08-26" }),
  1,
);
check(
  "resignation is never flagged — open-ended by design",
  flagged({ loai_nghi: "Nghỉ việc", leave_from: TODAY, leave_to: "2026-12-31" }),
  0,
);
check(
  "a to-date BEFORE the from-date is not a span",
  flagged({ leave_from: "2026-08-26", leave_to: TODAY }),
  0,
);
check("garbage dates are not reported", flagged({ leave_from: "hôm nay", leave_to: "mai" }), 0);

console.log("\nwhich spans are still worth showing");
check(
  "a span that ended yesterday is dropped",
  flagged({ leave_from: "2026-08-20", leave_to: "2026-08-24" }),
  0,
);
check(
  "a span ending TODAY is still shown",
  flagged({ leave_from: "2026-08-20", leave_to: TODAY }),
  1,
);
check(
  "a span starting next week is shown now, not on the day it misfires",
  flagged({ leave_from: "2026-09-01", leave_to: "2026-09-03" }),
  1,
);

console.log("\nwhat the panel is told about a flagged row");
const [row] = spanningLeaveRows(
  [
    entry({
      leave_from: "2026-08-29",
      leave_to: "2026-08-31",
      gio_bat_dau: "06:30",
      gio_ket_thuc: "15:30",
      subs: [{ id: "s1", name: "Người thay 1", from: null, to: null }],
    }),
  ],
  [],
  TODAY,
);
check("day count is inclusive of both ends", row?.days, 3);
check("the daily window is surfaced verbatim", row?.timeLabel, "06:30–15:30");
check("a named substitute is reported", row?.hasSub, true);
check("a row the engine can see is marked linked", row?.linked, true);

const noWindow = spanningLeaveRows(
  [entry({ leave_from: "2026-08-29", leave_to: "2026-08-30", gio_bat_dau: "06:30" })],
  [],
  TODAY,
);
check("half a window is no window", noWindow[0]?.timeLabel, null);

console.log("\nordering");
const many = spanningLeaveRows(
  [
    entry({ leave_from: "2026-09-10", leave_to: "2026-09-12" }),
    entry({ leave_from: "2026-08-26", leave_to: "2026-08-28" }),
    entry({ leave_from: "2026-09-01", leave_to: "2026-09-02" }),
  ],
  [],
  TODAY,
);
check("soonest span first", many.map((r) => r.leave_from).join(","), "2026-08-26,2026-09-01,2026-09-10");

console.log("\nrows the engine cannot see are spanning too");
function dropped(p: Partial<InvalidLeaveRow>): InvalidLeaveRow {
  return {
    driver_name: "F - P - DC101865 Cao Hoài Đức",
    loai_nghi: "",
    leave_from: "2026-08-29",
    leave_to: "2026-08-31",
    timeLabel: "06:30–15:30",
    hasSub: false,
    recovered: false,
    ...p,
  };
}
// The first spanning row this flag ever met was BOTH spanning and unlinked, and
// starts next week — so the red block ignores it (it does not cover today or
// tomorrow) and `entries` never held it at all.
const unlinked = spanningLeaveRows([], [dropped({})], TODAY);
check("an unlinked spanning row is still flagged", unlinked.length, 1);
check("and marked as unseen by the engine", unlinked[0]?.linked, false);
check(
  "a same-day dropped row is not dragged in",
  spanningLeaveRows([], [dropped({ leave_from: TODAY, leave_to: TODAY })], TODAY).length,
  0,
);

// A name-recovered row is BOTH in entries and reported as dropped.
const recoveredEntry = entry({
  driver_name: "F - P - DC101865 Cao Hoài Đức",
  leave_from: "2026-08-29",
  leave_to: "2026-08-31",
  gio_bat_dau: "06:30",
  gio_ket_thuc: "15:30",
});
const both = spanningLeaveRows([recoveredEntry], [dropped({ recovered: true })], TODAY);
check("a recovered row is listed once, not twice", both.length, 1);
check("and reads as linked — the engine does honour it", both[0]?.linked, true);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
