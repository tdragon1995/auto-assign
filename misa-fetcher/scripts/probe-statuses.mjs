/**
 * Discovery probe: what does MISA's attendance endpoint return for each Status
 * value? The sync pins Status 2; this shows what the others hold so we know what
 * "non-approved leave" actually looks like before writing any of it to the sheet.
 *
 *   node scripts/probe-statuses.mjs
 */
process.env.TZ = "Asia/Ho_Chi_Minh";
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, ensureLoggedIn } from "../lib/misa.mjs";
import { monthRange } from "../lib/parse.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(here, "..", ".state", "misa-state.json");
const ORIGIN = "https://amisapp.misa.vn";
const URL_ATT = `${ORIGIN}/APIS/g1/TimeSheetAPI/api/Attendance/v2/datapaging`;

// MISA rejects a shortened column list outright (Success=false, no error text),
// so this must stay the full set even though we only read a handful of fields.
const COLUMNS =
  "AttendanceID,EmployeeID,EmployeeCode,FullName,JobPositionID,JobPositionName,OrganizationUnitID,OrganizationUnitName,JobTitleID,RequestDate,DictionaryKey,FromDate,ToDate,LeaveDay,NumberOfHourLeave,AttendanceTypeID,AttendanceTypeName,AttendanceTypeName_EN,Reason,ApprovalName,Status,SubstituteName,RelationShipNames,Description,SalaryRate,DataSourceID,ApprovalToID,Step,NextStep,IsProcess,ProcessApprovalOldID,StepOld,NextStepOld,IsApplyProcessNew,UpdateWorkingProcess,SubstituteID,NoteAttendanceDay,RelationShipIDs,TotalLeaved,NumRemain,NumLeave,ThisMonth,NextMonth,AttendanceData,JobTitleName,ProcessApprovalOldValue,IsApply,EmployeeAttendance,EmployeeAttendanceIDs,EmployeeAttendanceCodes,EmployeeAttendanceNames,ShowEmployeeAttendance,WorkLocationName,TimeZone,SyncID,ProcessDetail";

const range = monthRange();
const year = range.year;

const { browser, context, page } = await createSession({ headless: true, statePath: STATE_PATH });

try {
  await ensureLoggedIn(
    page,
    context,
    {
      username: process.env.MISA_USERNAME,
      password: process.env.MISA_PASSWORD,
      totpSecret: process.env.MISA_TOTP_SECRET,
    },
    range,
    STATE_PATH,
  );

  for (const status of [0, 1, 2, 3, 4, 5]) {
    const filter = Buffer.from(
      JSON.stringify([["FromDate", ">", `${year}-01-01 23:59:59`]]),
    ).toString("base64");

    const payload = {
      PageSize: 100,
      PageIndex: 1,
      Filter: filter,
      CustomFilter: null,
      QuickSearch: null,
      CustomParam: {
        OrganizationUnitID: null,
        Status: status,
        SaveUserOption: {
          AttendanceWatchFilter: [
            {
              valueField: "FromDate",
              showInput: true,
              toDate: `${year}-01-01T16:59:59.059Z`,
              fromDate: `${year - 1}-12-31T17:00:00.000Z`,
              inputValue: "",
              isChecked: true,
              operator: ">",
              initText: null,
              initItems: null,
            },
          ],
        },
      },
      Sort: null,
      Columns: COLUMNS,
    };

    const r = await page.evaluate(
      async ({ url, body }) => {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/plain, */*" },
          credentials: "include",
          body: JSON.stringify(body),
        });
        return { status: resp.status, text: await resp.text() };
      },
      { url: URL_ATT, body: payload },
    );

    let rows = [];
    let ok = false;
    try {
      const d = JSON.parse(r.text);
      ok = d.Success;
      rows = Array.isArray(d.Data) ? d.Data : d.Data?.PageData || [];
    } catch {
      /* non-JSON */
    }

    const aug = rows.filter((x) => (x.FromDate || "").startsWith("2026-08"));
    console.log(`\n=== Status ${status} → HTTP ${r.status}, Success=${ok}, ${rows.length} rows (${aug.length} starting in Aug) ===`);
    for (const x of rows.slice(0, 3)) {
      console.log(
        `   ${x.EmployeeCode} ${x.FullName} | ${(x.FromDate || "").slice(0, 10)}→${(x.ToDate || "").slice(0, 10)} | ` +
          `Status=${x.Status} | IsApply=${x.IsApply} | LeaveDay=${x.LeaveDay} TotalLeaved=${x.TotalLeaved} NumRemain=${x.NumRemain} | ` +
          `IsProcess=${x.IsProcess} Step=${x.Step}->${x.NextStep}`,
      );
    }
    await page.waitForTimeout(400);
  }
} finally {
  await browser.close();
}
