/**
 * MISA Driver Shift pipeline — entrypoint.
 *
 * Logs into MISA AMIS with a fresh headless-browser session (username +
 * password + TOTP, fully automatic — nothing stored that can expire), fetches
 * the current month's shift schedule + leave requests, folds in the part-time
 * roster (staff with no AMIS access, kept as a weekly pattern in the sheet),
 * then writes to:
 *   1. Nghỉ phép tab  → approved leave, via POST /api/nghi-phep (engine source)
 *   2. Google Sheet   → "Driver Shift" flat tab + "Lịch Ca" month grid
 *   3. Supabase       → public.driver_shifts (dormant until keys are set)
 *
 * Flags:
 *   --dry-run      fetch + parse only; write JSON to out/, touch no sinks
 *   --no-sheet     skip the Google Sheet sinks
 *   --no-supabase  skip the Supabase sink
 *   --no-leave     skip the Nghỉ phép push
 *   --leave-dry    report the leave that would be written, but don't write it
 *   --month=YYYY-MM  target a specific month (default: current, VN time)
 *   --headed       run the browser visibly (local debugging)
 */

process.env.TZ = "Asia/Ho_Chi_Minh"; // all "current month" math is VN-local

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, ensureLoggedIn, fetchAllShifts, fetchAllAttendance } from "./lib/misa.mjs";
import { monthRange, buildLeaveMap, parseShifts } from "./lib/parse.mjs";
import { pushSupabase, pushSheet, pushGrid } from "./lib/sinks.mjs";
import {
  loadDrivers,
  driversByEmployeeCode,
  loadPtPatterns,
  expandPtPatterns,
  loadSheetLeave,
  PT_PATTERN_SHEET,
} from "./lib/sheet-read.mjs";
import { buildGrid } from "./lib/grid.mjs";
import { buildLeaveSubmissions, pushLeave } from "./lib/leave-push.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const STATE_PATH = path.join(here, ".state", "misa-state.json");
const OUT_DIR = path.join(here, "out");

const creds = {
  username: process.env.MISA_USERNAME,
  password: process.env.MISA_PASSWORD,
  totpSecret: process.env.MISA_TOTP_SECRET,
};

async function runOnce() {
  if (!creds.username || !creds.password || !creds.totpSecret) {
    throw new Error("MISA_USERNAME / MISA_PASSWORD / MISA_TOTP_SECRET must be set");
  }

  const monthArg = process.argv.slice(2).find((a) => a.startsWith("--month="));
  const range = monthRange(new Date(), monthArg ? monthArg.split("=")[1] : null);
  console.log(`[run] month range ${range.fromDate} → ${range.toDate} (VN)`);

  const { browser, context, page } = await createSession({
    headless: !args.has("--headed"),
    statePath: STATE_PATH,
  });

  try {
    await ensureLoggedIn(page, context, creds, range, STATE_PATH);

    const shiftData = await fetchAllShifts(page, range);
    const attendance = await fetchAllAttendance(page, range.year);
    const leaveMap = buildLeaveMap(attendance);
    const { sheetRows, records, gaps } = parseShifts(shiftData, leaveMap, attendance);

    console.log(
      `[run] parsed: ${shiftData.length} employees, ${records.length} shift rows, ` +
        `${attendance.length} leave records (${Object.keys(leaveMap).length} employee-days on leave)`,
    );

    // Days someone is away on leave but still rostered to work, with no leave
    // window attached — they would otherwise read as available. See findLeaveGaps.
    if (gaps.length) {
      console.warn(`[run] ⚠ ${gaps.length} leave/roster gap day(s) flagged:`);
      for (const g of gaps) {
        console.warn(
          `       ${g.date}  ${g.employee_code} ${g.full_name} — rostered ${g.rostered}, ` +
            `on ${g.leave_type} ${g.leave_from.slice(0, 10)}→${g.leave_to.slice(0, 10)}`,
        );
      }
    } else {
      console.log("[run] no leave/roster gaps found");
    }

    // ── Part-time roster ────────────────────────────────────────────────
    // ~70 active part-timers have no MISA account, so their shifts live in the
    // sheet as a weekly pattern. Anyone already covered by MISA is skipped, so
    // a person in both sources is never rostered twice.
    const drivers = await loadDrivers();
    const byCode = driversByEmployeeCode(drivers);
    const misaCodes = new Set(records.map((r) => r.employee_code));
    // Stamp the canonical Driver-tab label on every record. It is what the
    // Nghỉ phép sheet keys leave by, so leave can only be matched through it —
    // MISA supplies a bare name, which never matches.
    for (const r of records) {
      r.source = "MISA";
      r.label = byCode.get(r.employee_code)?.label || r.full_name;
    }

    const patterns = await loadPtPatterns();
    let ptRecords = [];
    if (patterns === null) {
      console.warn(
        `[run] ⚠ "${PT_PATTERN_SHEET}" tab not found — part-time roster skipped. ` +
          `Create it with headers: driver, employee_code, active_from, active_to, mon, tue, wed, thu, fri, sat, sun, note`,
      );
    } else {
      ptRecords = expandPtPatterns(patterns, range, misaCodes);
      const ptPeople = new Set(ptRecords.map((r) => r.employee_code));
      console.log(`[run] part-time: ${patterns.length} pattern(s) → ${ptPeople.size} people, ${ptRecords.length} day rows`);
    }

    const allRecords = [...records, ...ptRecords];

    // ── Leave → Nghỉ phép (the engine's source of truth) ────────────────
    const { submissions, unmatched } = buildLeaveSubmissions(attendance, byCode, range);
    if (unmatched.size) {
      console.warn(
        `[run] ⚠ ${unmatched.size} MISA employee(s) on leave have no active Cartrack driver — leave not pushed: ` +
          [...unmatched.entries()].map(([c, n]) => `${c} ${n}`).join("; "),
      );
    }
    let leaveResult = null;
    if (!args.has("--no-leave") && submissions.length) {
      leaveResult = await pushLeave(submissions, { dryRun: DRY_RUN || args.has("--leave-dry") });
      if (!DRY_RUN && !args.has("--leave-dry")) {
        console.log(
          `[run] leave push: ${leaveResult.written} written, ${leaveResult.duplicate} already present, ${leaveResult.failed} failed`,
        );
        for (const e of leaveResult.errors) console.error(`       ${e}`);
      }
    }

    // ── Build outputs ───────────────────────────────────────────────────
    // The grid overlays leave from the Nghỉ phép tab (read AFTER the push, so it
    // includes what we just wrote) — that covers part-timers MISA knows nothing
    // about and keeps the view aligned with what the engine reads.
    let sheetLeave = new Map();
    try {
      sheetLeave = await loadSheetLeave();
    } catch (e) {
      console.warn(`[run] ⚠ could not read Nghỉ phép for the grid overlay: ${e.message}`);
    }
    const grid = buildGrid(allRecords, range, sheetLeave);
    const ptSheetRows = ptRecords.map((r) => [
      r.employee_code,
      r.full_name,
      r.shift_date,
      r.day_type === "off" ? "OFF" : r.start_time || "",
      r.day_type === "working" ? r.end_time || "" : "",
      "",
      "",
      "",
    ]);
    const allSheetRows = [...sheetRows, ...ptSheetRows].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0,
    );

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const dump = path.join(OUT_DIR, `misa-shifts-${range.monthStart.slice(0, 7)}.json`);
    fs.writeFileSync(
      dump,
      JSON.stringify(
        {
          fetched_at: new Date().toISOString(),
          range,
          gaps,
          leaveSubmissions: submissions,
          sheetRows: allSheetRows,
          records: allRecords,
          grid,
          attendance,
        },
        null,
        2,
      ),
    );
    console.log(
      `[run] grid: ${grid.values.length - 1} people × ${grid.values[0].length - 4} days | debug dump → ${dump}`,
    );

    if (DRY_RUN) {
      console.log("[run] dry run — skipping all sinks");
      return;
    }
    if (allRecords.length === 0) {
      throw new Error("parsed 0 rows — refusing to overwrite existing data");
    }

    if (!args.has("--no-supabase")) await pushSupabase(allRecords, range);
    if (!args.has("--no-sheet")) {
      await pushSheet(allSheetRows);
      await pushGrid(grid, range);
    }
    console.log("[run] done ✅");
  } finally {
    await browser.close();
  }
}

// One retry with a clean slate: a half-expired saved session or an unlucky
// Cloudflare challenge should not fail the whole scheduled run.
try {
  await runOnce();
} catch (err) {
  console.error(`[run] first attempt failed: ${err.message}`);
  console.error("[run] retrying once with fresh session state...");
  fs.rmSync(STATE_PATH, { force: true });
  await runOnce();
}
