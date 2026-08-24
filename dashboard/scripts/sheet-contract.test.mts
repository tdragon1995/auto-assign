/**
 * The guard that decides whether a spreadsheet tab is still readable.
 *
 * Every load guard in this codebase used to be a total-emptiness check, so the
 * only accident it caught was the sheet vanishing outright. The three that
 * actually happen all parse cleanly:
 *
 *   1. a column renamed or deleted by hand;
 *   2. Google answering with an HTML permissions page, sometimes under HTTP 200;
 *   3. the by-name lookup being handed the WRONG TAB — Google answers an unknown
 *      sheet name with the first tab in the workbook rather than an error, and
 *      here that is the ~1,700-row customer→driver mapping, which parses
 *      perfectly and means something else entirely.
 *
 * Case 3 is the one worth keeping a test for: nothing about the response looks
 * wrong, so only the column contract can tell the difference.
 *
 *   npx tsx scripts/sheet-contract.test.mts
 */
const {
  assertHeaders, assertCsvResponse, isSheetShapeError,
  parseCSVWithHeaders, SHEET_CONTRACT,
  noteSheetLoad, drainSheetAlarms,
} = await import("../src/lib/sheets");

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

/** Run `fn`, reporting whether it refused and (when it did) why. */
function refusal(fn: () => void): { refused: boolean; reason: string } {
  try { fn(); return { refused: false, reason: "" }; }
  catch (e) {
    return { refused: isSheetShapeError(e), reason: isSheetShapeError(e) ? e.reason : String(e) };
  }
}

// Header rows copied from the live workbook, 2026-08-24.
const HEADERS = {
  mapping: "customer_id,driver_id,alt_drop_off_id,Điểm Pick-up,Điểm Drop-off thay thế,Driver,bot_token,chat_id,shift_start,shift_end,smart_driver_id,Column 12",
  sunday: "customer_id,driver_id,alt_drop_off_id,Điểm Pick-up,Điểm Drop-off thay thế,Driver,shift_start,shift_end,f=fx,drop_off_name,area_public_on_schedule,Muti rows,Group ID,smart_driver_id",
  drivers: "Driver,delivery_driver_id,driver_zalo_id,bot_token,employee_code,employee_full_name,email,phone_code,phone_number,phone_number_update,shift_time_start,shift_time_end,start_location_customer_id,end_location_customer_id,code_name,is_active",
  nghi_phep: "Ngày Nộp Đơn,driver_id,driver,Loại Nghỉ,leave_from,leave_to,leave_from_hr,leave_to_hr,day,sub1_name,sub1_id,sub1_from,sub1_to,note,Vị trí",
  tpl: "psc-tinh,3pl,3pl_uuid,address",
  schedule_job: "pickup_id,pickup,dropoff_id,dropoff,delivery_windows,sent_to_driver_before,reference,monday,tuesday,wednesday,thursday,friday,saturday,sunday,driver_id,Driver",
  public_sunday: "Ngày làm việc,STT,Họ và tên,Địa điểm,Ca,Ghi chú,Số điện thoại,Xin nghỉ",
} as const;

const cols = (headerRow: string) => headerRow.split(",");

// ── Every contract passes against the sheet as it is today ──────────────────
// The failure this catches is a contract requiring a column that does not exist:
// the tab would then be refused on EVERY load and the engine would run on a
// stale copy for as long as nobody noticed.
console.log("contracts vs the live headers");
for (const [key, contract] of Object.entries(SHEET_CONTRACT)) {
  const header = HEADERS[key as keyof typeof HEADERS];
  const r = refusal(() => assertHeaders(contract.label, cols(header), contract.require));
  check(`${key} accepts its own tab`, !r.refused, r.reason);
}

// ── A column removed by hand ────────────────────────────────────────────────
console.log("\na deleted or renamed column");
{
  const without = cols(HEADERS.mapping).filter((c) => c !== "driver_id");
  const r = refusal(() => assertHeaders("config (mapping)", without, SHEET_CONTRACT.mapping.require));
  check("mapping missing driver_id is refused", r.refused);
  check("the refusal names the column", r.reason.includes("driver_id"), r.reason);
}
{
  // Renaming is indistinguishable from deleting, which is the point.
  const renamed = cols(HEADERS.nghi_phep).map((c) => (c === "leave_from" ? "leave_start" : c));
  const r = refusal(() => assertHeaders("Leave Status", renamed, SHEET_CONTRACT.nghi_phep.require));
  check("leave with a renamed date column is refused", r.refused);
}
{
  // A column the reader tolerates must NOT be in the contract. The Sunday tab
  // genuinely has no bot_token, so requiring it would refuse the tab every week.
  const r = refusal(() => assertHeaders("CONFIG SUNDAY", cols(HEADERS.sunday), SHEET_CONTRACT.sunday.require));
  check("Sunday is accepted despite having no bot_token", !r.refused, r.reason);
  check("no contract requires bot_token",
    !Object.values(SHEET_CONTRACT).some((c) => (c.require as readonly string[]).includes("bot_token")));
}

// ── The wrong tab, which is why this file exists ────────────────────────────
console.log("\nthe wrong tab answered by name");
{
  // What the by-name endpoint actually returns when the tab has been renamed.
  const r = refusal(() =>
    assertHeaders("PUBLIC SUNDAY SCHEDULE", cols(HEADERS.mapping), SHEET_CONTRACT.public_sunday.require));
  check("mapping served in place of the Sunday schedule is refused", r.refused);
  check("the refusal names a column the schedule should have",
    r.reason.includes("Họ và tên"), r.reason);
}
{
  // And the reverse, so the contracts are actually distinguishing tabs rather
  // than all happening to pass.
  const r = refusal(() =>
    assertHeaders("config (mapping)", cols(HEADERS.public_sunday), SHEET_CONTRACT.mapping.require));
  check("the schedule served in place of mapping is refused", r.refused);
}

// ── An HTML error page ──────────────────────────────────────────────────────
console.log("\nan HTML page instead of a sheet");
{
  const html = new Response("<!doctype html><html><body>Sign in</body></html>", {
    status: 200, headers: { "content-type": "text/html; charset=utf-8" },
  });
  const r = refusal(() => assertCsvResponse("config (mapping)", html));
  check("HTML under HTTP 200 is refused", r.refused);
}
{
  const csv = new Response("a,b\n1,2", { status: 200, headers: { "content-type": "text/csv" } });
  check("real CSV is accepted", !refusal(() => assertCsvResponse("x", csv)).refused);
}
{
  // Absent content-type must not fail a load that would otherwise have worked.
  const bare = new Response("a,b\n1,2", { status: 200 });
  const r = refusal(() => assertCsvResponse("x", bare));
  check("a missing content-type is tolerated", !r.refused, r.reason);
}
{
  // Even so, a markup body cannot pass the column contract — the two checks
  // cover for each other.
  const { headers } = parseCSVWithHeaders("<!doctype html>\n<html><body>Sign in</body></html>");
  const r = refusal(() => assertHeaders("config (mapping)", headers, SHEET_CONTRACT.mapping.require));
  check("markup parsed as CSV still fails the contract", r.refused);
}

// ── The alarm only speaks when something changes ────────────────────────────
// Upstash bills per command against a cap this project is already projected to
// exceed, so a healthy fleet must write nothing at all.
console.log("\nthe alarm reports changes, not states");
{
  drainSheetAlarms(); // clear anything the checks above recorded
  check("nothing to say when nothing happened", drainSheetAlarms() === null);

  const err = refusal(() => assertHeaders("config (mapping)", cols(HEADERS.public_sunday), SHEET_CONTRACT.mapping.require));
  check("…the setup actually failed", err.refused);

  noteSheetLoad("config (mapping)", { kind: "sheet-shape", sheetLabel: "config (mapping)", reason: "thiếu cột customer_id" } as never);
  const raised = drainSheetAlarms();
  check("a refusal is reported once", raised?.length === 1, JSON.stringify(raised));
  check("and only once", drainSheetAlarms() === null);

  noteSheetLoad("config (mapping)", null);
  const cleared = drainSheetAlarms();
  check("a clean load clears it", Array.isArray(cleared) && cleared.length === 0, JSON.stringify(cleared));
  check("and stays quiet afterwards", drainSheetAlarms() === null);

  // A tab that was already fine must not generate traffic.
  noteSheetLoad("3PL", null);
  check("a clean load of a healthy tab says nothing", drainSheetAlarms() === null);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
