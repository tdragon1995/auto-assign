/**
 * MISA AMIS session + data fetch, driven through a real (headless) Chromium page.
 *
 * Why a browser: the TimeSheet APIs sit behind Cloudflare + F5 + reCAPTCHA which
 * fingerprint the client and mint IP-bound cookies. Plain HTTP from a server IP
 * gets blocked — which is why the old Apps Script version needed cookies pasted
 * by hand, and why a bare POST to /Account/login returns "wrong password" even
 * with valid credentials (reCAPTCHA gate). So we drive the actual login *form*
 * (MISA's own page code runs reCAPTCHA + the device handshake), then make every
 * data call *inside* the page so the browser supplies all cookies automatically.
 * Nothing long-lived is stored — each run can log in from scratch.
 *
 * Login: fill username + password → submit → TOTP (Google Authenticator) → land
 * authenticated. Then cookie-authenticated in-page POSTs to the datapaging APIs.
 */

import { chromium } from "playwright";
import { authenticator } from "otplib";
import fs from "node:fs";
import path from "node:path";

const ORIGIN = "https://amisapp.misa.vn";

const URLS = {
  shift: `${ORIGIN}/APIS/g1/TimeSheetAPI/api/ShiftPlanEmployee/v2/datapaging`,
  attendance: `${ORIGIN}/APIS/g1/TimeSheetAPI/api/Attendance/v2/datapaging`,
};

const WRONG_CREDS_TEXT = "Tên đăng nhập hoặc mật khẩu không đúng";

const SHIFT_PAGE_SIZE = 200;
const ATTENDANCE_PAGE_SIZE = 100; // MISA caps this endpoint at 100/page

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function log(msg) {
  console.log(`[misa] ${msg}`);
}

// ---------------------------------------------------------------- session ---

export async function createSession({ headless = true, statePath } = {}) {
  const browser = await chromium.launch({ headless });
  const hasState = statePath && fs.existsSync(statePath);
  const context = await browser.newContext({
    userAgent: UA,
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    viewport: { width: 1366, height: 768 },
    ...(hasState ? { storageState: statePath } : {}),
  });
  const page = await context.newPage();
  if (hasState) log(`reusing saved session state from ${statePath}`);
  return { browser, context, page };
}

/** Navigate to the MISA origin and wait out any Cloudflare interstitial. */
async function landOnOrigin(page, pathname = "/") {
  await page.goto(`${ORIGIN}${pathname}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  for (let i = 0; i < 30; i++) {
    const title = (await page.title().catch(() => "")) || "";
    if (!/just a moment|attention required|đang kiểm tra/i.test(title)) break;
    log(`cloudflare interstitial ("${title}") — waiting...`);
    await page.waitForTimeout(2000);
  }
}

/**
 * Park the page on a static same-origin document before making in-page API
 * calls. Landing on "/" loads the SPA, which keeps client-side routing while our
 * fetches run and tears the execution context out from under page.evaluate
 * ("Execution context was destroyed"). robots.txt is inert, and same-origin is
 * all that matters for cookies.
 */
async function landOnStaticPage(page) {
  await landOnOrigin(page, "/robots.txt");
}

/** Run a fetch inside the page so the browser attaches cookies + fingerprint. */
async function pageFetch(page, url, { method = "GET", body } = {}) {
  const result = await page.evaluate(
    async ({ url, method, body }) => {
      const headers = { Accept: "application/json, text/plain, */*" };
      if (body != null) headers["Content-Type"] = "application/json";
      const resp = await fetch(url, {
        method,
        headers,
        credentials: "include",
        body: body != null ? JSON.stringify(body) : undefined,
      });
      return { status: resp.status, text: await resp.text() };
    },
    { url, method, body },
  );
  let data = null;
  try {
    data = result.text ? JSON.parse(result.text) : null;
  } catch {
    /* non-JSON body (e.g. an HTML error/login page) — caller inspects status */
  }
  return { status: result.status, data, text: result.text };
}

/** Cheap probe: does the current session get real data from the shift API? */
async function sessionIsAlive(page, range) {
  if (!page.url().startsWith(ORIGIN)) return false;
  const resp = await pageFetch(page, URLS.shift, {
    method: "POST",
    body: shiftPayload(range.fromDate, range.toDate, 1, 1),
  });
  return resp.status === 200 && resp.data && resp.data.Success === true;
}

/** Drive the real login form: username + password → TOTP → authenticated. */
async function login(page, context, { username, password, totpSecret }) {
  await landOnOrigin(page);

  const user = page.getByPlaceholder("Số điện thoại/email");
  try {
    await user.waitFor({ timeout: 30_000 });
  } catch {
    // No login form: cookies are good enough for the SPA even though the API
    // probe failed. Let the caller re-probe rather than fail here.
    if (!(await page.evaluate(() => location.pathname.startsWith("/login")))) {
      log("no login form shown — already authenticated at app level");
      return;
    }
    throw new Error("MISA login form did not appear");
  }

  log("filling credentials...");
  await user.fill(username);
  await page.getByPlaceholder("Mật khẩu").fill(password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();

  // Three possible outcomes: the OTP prompt, a credential error, or straight
  // through (when MISA still remembers this device from a previous run).
  await page.waitForFunction(
    (errText) =>
      !!document.querySelector('input[name="otp"]') ||
      (document.body.innerText || "").includes(errText) ||
      !location.pathname.startsWith("/login"),
    WRONG_CREDS_TEXT,
    { timeout: 45_000 },
  );

  if (!(await page.evaluate(() => location.pathname.startsWith("/login")))) {
    log("device remembered — logged in without an OTP prompt");
  } else {
    if (await page.evaluate((t) => (document.body.innerText || "").includes(t), WRONG_CREDS_TEXT)) {
      throw new Error("MISA rejected credentials — wrong username or password");
    }

    const otpField = page.locator('input[name="otp"]');
    await otpField.waitFor({ timeout: 15_000 });
    const otp = authenticator.generate(totpSecret);
    log(`entering TOTP ${otp}...`);
    await otpField.fill(otp);

    // "Không hỏi lại trên thiết bị này" — remember device to cut future prompts.
    const remember = page.locator('input[name="remember"]');
    if (await remember.count()) await remember.check().catch(() => {});

    const cont = page.getByRole("button", { name: "Tiếp tục" });
    if (await cont.count().catch(() => 0)) {
      await cont.click().catch(() => otpField.press("Enter"));
    } else {
      await otpField.press("Enter");
    }

    await page
      .waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 45_000 })
      .catch(() => {});
    await page.waitForTimeout(3000);
  }
  log(`post-login URL: ${page.url()}`);
}

/**
 * Ensure the page holds a working MISA session, reusing saved state when valid
 * and logging in from scratch otherwise. Auth lives entirely in the browser
 * context's cookies afterwards.
 */
export async function ensureLoggedIn(page, context, creds, range, statePath) {
  await landOnStaticPage(page);

  if (await sessionIsAlive(page, range)) {
    log("saved session still valid — skipping login");
    return;
  }

  await login(page, context, creds);
  await landOnStaticPage(page);

  if (!(await sessionIsAlive(page, range))) {
    // Some tenants only mint the session cookie once the SPA boots; nudge it.
    log("session probe failed after login — loading /timesheet/ once and retrying...");
    await page
      .goto(`${ORIGIN}/timesheet/`, { waitUntil: "networkidle", timeout: 60_000 })
      .catch(() => {});
    await page.waitForTimeout(3000);
    await landOnStaticPage(page);
    if (!(await sessionIsAlive(page, range))) {
      throw new Error("MISA session probe still failing after full login — see logs");
    }
  }

  if (statePath) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    await context.storageState({ path: statePath });
    log(`session state saved to ${statePath}`);
  }
}

// ------------------------------------------------------------ shift fetch ---

// base64 of [{"selector":"EmployeeCode","desc": false}]
const SHIFT_SORT = "W3sic2VsZWN0b3IiOiJFbXBsb3llZUNvZGUiLCJkZXNjIjogZmFsc2V9XQ==";

function shiftPayload(fromDate, toDate, pageIndex, pageSize = SHIFT_PAGE_SIZE) {
  return {
    PageSize: pageSize,
    PageIndex: pageIndex,
    Sort: SHIFT_SORT,
    CustomParam: {
      FromDate: fromDate,
      ToDate: toDate,
      OrganizationUnitID: null,
      Status: 0,
      Inactive: false,
      IsGroup: false,
      FieldGroup: 1,
      IsShowTotalWorkingRate: false,
    },
    QuickSearch: { SearchValue: "", Columns: ["FullName", "EmployeeCode", "OtherName"] },
  };
}

export async function fetchAllShifts(page, range) {
  const all = [];
  for (let pageIndex = 1; ; pageIndex++) {
    const resp = await pageFetch(page, URLS.shift, {
      method: "POST",
      body: shiftPayload(range.fromDate, range.toDate, pageIndex),
    });
    if (resp.status !== 200 || !resp.data?.Success) {
      throw new Error(
        `shift fetch page ${pageIndex} failed (HTTP ${resp.status}): ${resp.data?.UserMessage || resp.text?.slice(0, 200)}`,
      );
    }
    const rows = resp.data.Data?.PageData || [];
    log(`shift page ${pageIndex}: ${rows.length} employees`);
    all.push(...rows);
    if (rows.length < SHIFT_PAGE_SIZE) break;
    await page.waitForTimeout(300);
  }
  return all;
}

// ------------------------------------------------------- attendance fetch ---

// Full column list from the proven working request — MISA rejects shorter lists.
const ATTENDANCE_COLUMNS =
  "AttendanceID,EmployeeID,EmployeeCode,FullName,JobPositionID,JobPositionName,OrganizationUnitID,OrganizationUnitName,JobTitleID,RequestDate,DictionaryKey,FromDate,ToDate,LeaveDay,NumberOfHourLeave,AttendanceTypeID,AttendanceTypeName,AttendanceTypeName_EN,Reason,ApprovalName,Status,SubstituteName,RelationShipNames,Description,SalaryRate,DataSourceID,ApprovalToID,Step,NextStep,IsProcess,ProcessApprovalOldID,StepOld,NextStepOld,IsApplyProcessNew,UpdateWorkingProcess,SubstituteID,NoteAttendanceDay,RelationShipIDs,TotalLeaved,NumRemain,NumLeave,ThisMonth,NextMonth,AttendanceData,JobTitleName,ProcessApprovalOldValue,IsApply,EmployeeAttendance,EmployeeAttendanceIDs,EmployeeAttendanceCodes,EmployeeAttendanceNames,ShowEmployeeAttendance,WorkLocationName,TimeZone,SyncID,ProcessDetail";

function attendancePayload(year, pageIndex) {
  // Server-side filter: FromDate > Jan 1 of the current year. Per-month narrowing
  // happens client-side when leave rows are joined onto shift dates.
  const filter = Buffer.from(
    JSON.stringify([["FromDate", ">", `${year}-01-01 23:59:59`]]),
  ).toString("base64");
  return {
    PageSize: ATTENDANCE_PAGE_SIZE,
    PageIndex: pageIndex,
    Filter: filter,
    CustomFilter: null,
    QuickSearch: null,
    CustomParam: {
      OrganizationUnitID: null,
      Status: 2, // matches the MISA "attendance-watch" view the ops team uses
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
    Columns: ATTENDANCE_COLUMNS,
  };
}

export async function fetchAllAttendance(page, year) {
  const all = [];
  for (let pageIndex = 1; ; pageIndex++) {
    const resp = await pageFetch(page, URLS.attendance, {
      method: "POST",
      body: attendancePayload(year, pageIndex),
    });
    if (resp.status !== 200 || !resp.data?.Success) {
      throw new Error(
        `attendance fetch page ${pageIndex} failed (HTTP ${resp.status}): ${resp.data?.UserMessage || resp.text?.slice(0, 200)}`,
      );
    }
    // This endpoint returns Data as the array directly (unlike the shift API).
    const rows = Array.isArray(resp.data.Data)
      ? resp.data.Data
      : resp.data.Data?.PageData || [];
    log(`attendance page ${pageIndex}: ${rows.length} leave records`);
    all.push(...rows);
    if (rows.length < ATTENDANCE_PAGE_SIZE) break;
    await page.waitForTimeout(300);
  }
  return all;
}
