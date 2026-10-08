/** Shared MISA pipeline for CLI and Vercel. Browser/OTP runtime is supplied by the caller. */
import fs from "node:fs";
import path from "node:path";
import { createSession, ensureLoggedIn, fetchAllShifts, fetchAllAttendance } from "./misa.mjs";
import { monthRange, buildLeaveMap, parseShifts } from "./parse.mjs";
import { pushSupabase } from "./sinks.mjs";
import {
  loadDrivers,
  driversByEmployeeCode,
  loadPtPatterns,
  expandPtPatterns,
  loadSheetLeave,
  PT_PATTERN_SHEET,
} from "./sheet-read.mjs";
import { buildGrid } from "./grid.mjs";
import { buildLeaveSubmissions, pushLeave } from "./leave-push.mjs";

export async function runMisaSync({creds,chromium,launchOptions,month,flags=[],statePath,outDir,writeDump=true}={}) {
  const args=new Set(flags),DRY_RUN=args.has("--dry-run");
  const STATE_PATH=statePath,OUT_DIR=outDir;
  if (!creds?.username || !creds.password || !creds.totpSecret) {
    throw new Error("MISA_USERNAME / MISA_PASSWORD / MISA_TOTP_SECRET must be set");
  }

  const argv = flags;
  const monthArg = argv.find((a) => a.startsWith("--month="));
  const monthsArg = argv.find((a) => a.startsWith("--months="));
  const offsetArg = argv.find((a) => a.startsWith("--start-offset="));

  // Cover payroll retention (15th two months back) through the end of next month.
  // The database clips historical rows at its exact payroll cutoff.
  const span = monthsArg ? Number(monthsArg.split("=")[1]) : (month || monthArg ? 1 : 4);
  const startOffset = offsetArg ? Number(offsetArg.split("=")[1]) : -2;
  const startMonth =
    month ?? monthArg?.split("=")[1] ??
    (() => {
      const now = new Date();
      const d = new Date(now.getFullYear(), now.getMonth() + startOffset, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    })();

  const range = monthRange(new Date(), startMonth, span);
  console.log(
    `[run] range ${range.monthStart} → ${range.monthEnd} (${range.months} month(s), VN)`,
  );

  const drivers = await loadDrivers(); // Fail before MISA login or leave writes when Supabase is unavailable.
  const { browser, context, page } = await createSession({
    chromium,launchOptions,headless: !args.has("--headed"),
    statePath: STATE_PATH,
  });

  try {
    await ensureLoggedIn(page, context, creds, range, STATE_PATH);

    const shiftData = await fetchAllShifts(page, range);
    // The attendance endpoint filters by year, so a span crossing Dec→Jan needs
    // one pass per year. Records are deduped on AttendanceID.
    const attendance = [];
    const seenAtt = new Set();
    for (const yr of range.years) {
      for (const a of await fetchAllAttendance(page, yr)) {
        const id = a.AttendanceID ?? JSON.stringify([a.EmployeeCode, a.FromDate, a.ToDate]);
        if (seenAtt.has(id)) continue;
        seenAtt.add(id);
        attendance.push(a);
      }
    }
    const leaveMap = buildLeaveMap(attendance);
    const { records, gaps } = parseShifts(shiftData, leaveMap, attendance);

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
    const byCode = driversByEmployeeCode(drivers);
    // Being in MISA is not the same as having a roster there: 30 of 88 people
    // have an AMIS account but no shift plan, so they arrive as a month of
    // blank days. Only someone who actually works a day in MISA is "covered" —
    // anyone else must still be fillable from the part-time tab, or they could
    // never be rostered at all.
    const rosteredInMisa = new Set(
      records.filter((r) => r.day_type === "working").map((r) => r.employee_code),
    );
    // Stamp the canonical Driver-tab label on every record. It is what the
    // Nghỉ phép sheet keys leave by, so leave can only be matched through it —
    // MISA supplies a bare name, which never matches.
    for (const r of records) {
      r.source = "MISA";
      r.driver_id = byCode.get(r.employee_code)?.driver_id ?? null;
      r.label = byCode.get(r.employee_code)?.label || r.full_name;
    }

    const patterns = await loadPtPatterns();
    const ptRecords = expandPtPatterns(patterns, range, rosteredInMisa);
    const ptPeople = new Set(ptRecords.map((r) => r.employee_code));
    console.log(`[run] part-time: ${patterns.length} pattern(s) → ${ptPeople.size} people, ${ptRecords.length} day rows`);

    // Where the pattern tab now supplies someone who had only blank MISA days,
    // drop those blanks — otherwise the same person appears twice.
    const ptCodes = new Set(ptRecords.map((r) => r.employee_code));
    const allRecords = [
      ...records.filter((r) => {
        // Superseded by a pattern row — would otherwise appear twice.
        if (ptCodes.has(r.employee_code) && !rosteredInMisa.has(r.employee_code)) return false;
        // No shift anywhere AND not an active driver: a former or non-driving
        // employee MISA still lists. They can never take a job, so a blank row
        // for them is noise that buries the people who genuinely need a shift.
        if (!rosteredInMisa.has(r.employee_code) && !byCode.has(r.employee_code)) return false;
        return true;
      }),
      ...ptRecords,
    ];
    const droppedInactive = new Set(
      records
        .filter((r) => !rosteredInMisa.has(r.employee_code) && !byCode.has(r.employee_code))
        .map((r) => r.employee_code),
    );
    if (droppedInactive.size) {
      console.log(`[run] hid ${droppedInactive.size} inactive person/people with no shift`);
    }

    // Anyone left with no working day anywhere needs a pattern entered — flag
    // them, or a blank row just looks like someone who never works.
    const noRoster = new Map();
    for (const r of allRecords) {
      if (r.day_type === "working") noRoster.delete(r.employee_code);
      else if (!noRoster.has(r.employee_code) && !rosteredInMisa.has(r.employee_code) && !ptCodes.has(r.employee_code)) {
        noRoster.set(r.employee_code, r.full_name);
      }
    }
    for (const r of allRecords) {
      if (noRoster.has(r.employee_code)) r.source = "CHƯA CÓ CA";
    }
    if (noRoster.size) {
      console.warn(
        `[run] ⚠ ${noRoster.size} người chưa có ca (no shift in MISA and no pattern row) — ` +
          `add them to "${PT_PATTERN_SHEET}": ` +
          [...noRoster.entries()].map(([c, n]) => `${c} ${n}`).join("; "),
      );
    }

    // ── Leave → Nghỉ phép (the engine's source of truth) ────────────────
    // `roster` is the whole Driver tab, not the code-keyed map: the part-time
    // twin is found by NAME, and a twin need not carry an employee_code at all.
    const { submissions, unmatched, ptUnresolved } = buildLeaveSubmissions(
      attendance,
      byCode,
      range,
      { roster: drivers },
    );
    if (unmatched.size) {
      console.warn(
        `[run] ⚠ ${unmatched.size} MISA employee(s) on leave have no active Cartrack driver — leave not pushed: ` +
          [...unmatched.entries()].map(([c, n]) => `${c} ${n}`).join("; "),
      );
    }
    // A name matching two part-time accounts is left alone rather than guessed
    // at — but silently leaving it alone is how the twin keeps taking evening
    // work on a day off, so say which people need looking at.
    if (ptUnresolved.size) {
      console.warn(
        `[run] ⚠ ${ptUnresolved.size} người nghỉ có NHIỀU tài khoản PT trùng tên — chưa tạo dòng nghỉ PT: ` +
          [...ptUnresolved.entries()].map(([c, n]) => `${c} ${n}`).join("; "),
      );
    }
    const ptRows = submissions.filter((s) => s.pt_companion).length;
    if (ptRows) console.log(`[run] leave: ${ptRows} dòng nghỉ PT kèm theo`);
    let leaveResult = null;
    if (!args.has("--no-leave") && submissions.length) {
      leaveResult = await pushLeave(submissions, { dryRun: DRY_RUN || args.has("--leave-dry") });
      if (!DRY_RUN && !args.has("--leave-dry")) {
        console.log(
          `[run] leave push: ${leaveResult.written} written, ${leaveResult.duplicate} already present, ` +
            `${leaveResult.suppressed} suppressed (đã xoá thủ công), ${leaveResult.failed} failed` +
            (leaveResult.aborted ? " — DỪNG SỚM: bảng nghỉ phép chưa đọc được" : ""),
        );
        for (const e of leaveResult.errors) console.error(`       ${e}`);
        if(leaveResult.failed || leaveResult.aborted) throw new Error("MISA leave synchronization incomplete; retained existing shift data");
      }
    }

    // ── Build outputs ───────────────────────────────────────────────────
    // The grid overlays leave from the Nghỉ phép tab (read AFTER the push, so it
    // includes what we just wrote) — that covers part-timers MISA knows nothing
    // about and keeps the view aligned with what the engine reads.
    if(writeDump) {
    let sheetLeave = new Map();
    try {
      sheetLeave = await loadSheetLeave();
    } catch (e) {
      console.warn(`[run] ⚠ could not read Nghỉ phép for the grid overlay: ${e.message}`);
    }
    const grid = buildGrid(allRecords, range, sheetLeave);

    // Both outputs derive from the same filtered records, so the flat tab and
    // the grid can never disagree about who is on the roster. (parseShifts also
    // returns sheetRows, but those predate the filtering above.)
    const allSheetRows = allRecords
      .map((r) => [
        r.employee_code,
        r.full_name,
        r.shift_date,
        r.day_type === "holiday" ? r.holiday_name || "" : r.day_type === "off" ? "OFF" : r.start_time || "",
        r.day_type === "working" ? r.end_time || "" : "",
        r.leave_start || "",
        r.leave_end || "",
        r.leave_gap ? "1" : "",
      ])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));

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
      `[run] grid: ${grid.values.length - grid.frozenRows} people × ${grid.values[0].length - 4} days | debug dump → ${dump}`,
    );

    }
    if (DRY_RUN) {
      console.log("[run] dry run — skipping all sinks");
      return;
    }
    if (allRecords.length === 0) {
      throw new Error("parsed 0 rows — refusing to overwrite existing data");
    }

    if (!args.has("--no-supabase")) await pushSupabase(allRecords, range);

    console.log("[run] done ✅");
    return {shiftRows:allRecords.length,leave:leaveResult,gaps:gaps.length,unlinked:unmatched.size,unresolvedPt:ptUnresolved.size};
  } finally {
    await browser.close();
  }
}

