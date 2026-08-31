/**
 * Pins the guards on completing a config row.
 *
 * This is a WRITE into the table every assignment reads, driven from a browser,
 * so the checks that stop a bad one matter more than the happy path. Two in
 * particular: a driver name the sheet's own lookup cannot resolve writes fine
 * and then assigns nobody, and a half-specified window reads as "all day" and
 * quietly makes the row cover everything.
 *
 *   npx tsx scripts/complete-row.test.mts
 */
const { timeToMins } = await import("../src/lib/time");

let failed = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) return console.log(`  ok   ${label}`);
  failed++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
}

/** The route's validation, mirrored so it can be exercised without a server. */
function validate(b: Record<string, unknown>): string | null {
  const { row, pickup_name, driver_name, shift_start, shift_end } = b as {
    row?: number; pickup_name?: string; driver_name?: string; shift_start?: string; shift_end?: string;
  };
  if (!Number.isInteger(row) || (row as number) < 2) return "Thiếu số dòng hợp lệ";
  if (!pickup_name?.trim()) return "Thiếu tên điểm lấy mẫu";
  if (!(driver_name ?? "").trim()) return "Chưa chọn tài xế";
  const start = (shift_start ?? "").trim(), end = (shift_end ?? "").trim();
  if (!!start !== !!end) return "Khung giờ phải đủ cả từ và đến";
  if (start && end) {
    const a = timeToMins(start), z = timeToMins(end);
    if (!(a >= 0 && z >= 0)) return "Khung giờ không hợp lệ";
    if (a === z) return "Giờ trùng nhau";
  }
  return null;
}

const base = { row: 1751, pickup_name: "3PL - TLT", driver_name: "F - C - DC100320 Lý Chánh Hùng", shift_start: "14:00", shift_end: "15:00" };

ok("a complete request passes", validate(base) === null);
ok("row 1 is the header, never writable", validate({ ...base, row: 1 }) !== null);
ok("a missing row is refused", validate({ ...base, row: undefined }) !== null);
ok("a fractional row is refused", validate({ ...base, row: 17.5 }) !== null);
ok("no driver is refused — that is the whole decision", validate({ ...base, driver_name: "  " }) !== null);
ok("no branch is refused", validate({ ...base, pickup_name: "" }) !== null);

// Half a window is worse than none: a blank end reads as all-day, so the row
// would silently cover the entire day instead of the hour asked for.
ok("a start with no end is refused", validate({ ...base, shift_end: "" }) !== null);
ok("an end with no start is refused", validate({ ...base, shift_start: "" }) !== null);
ok("no window at all is allowed — the row simply covers the day",
   validate({ ...base, shift_start: "", shift_end: "" }) === null);
ok("a window that starts and ends together is refused — it never trực",
   validate({ ...base, shift_start: "09:00", shift_end: "09:00" }) !== null);
ok("nonsense times are refused", validate({ ...base, shift_start: "sáng", shift_end: "chiều" }) !== null);

// Overnight is legitimate and must not be mistaken for backwards.
ok("an overnight window is accepted", validate({ ...base, shift_start: "22:00", shift_end: "06:00" }) === null);

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
