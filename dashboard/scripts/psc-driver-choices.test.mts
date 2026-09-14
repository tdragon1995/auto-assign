/**
 * Pins who a branch may pick for a PSC trip (`resolveDriverChoices`): every driver whose
 * roster row covers any minute within ±10 minutes of the request time. A request at 12:00
 * reads the rows covering 11:50–12:10.
 *
 * It is a list for a person to choose from, so rows are UNIONED — but destination rows
 * still replace blank ones, redirecting rows stay with the engine, proxies are never
 * offered, and leave is judged at the REAL clock.
 *
 *   npx tsx scripts/psc-driver-choices.test.mts
 */
import type { Config, Mapping } from "../src/lib/types";
import type { LeaveEntry } from "../src/lib/leave-config";
const { resolveDriverChoices } = await import("../src/lib/fixed-driver");
const { vnDate } = await import("../src/lib/time");

let failed = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) return console.log(`  ok   ${label}`);
  failed++;
  console.log(`  FAIL ${label}\n       ${JSON.stringify(detail)}`);
}

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const [A, B, C, P1, P2, SUB] = [1, 2, 3, 5, 6, 7].map(id);
const PICK = "pickup-1", LAB = "lab-1", HUB = "hub-1";
const PROXY = "a8c48608-45d0-11f1-9378-fa163ee8d8ac";

const t = (s: string) => { const [h, m] = s.split(":").map(Number); return { hours: h, minutes: m }; };
const row = (driver: string | string[], start = "", end = "", extra: Partial<Mapping> = {}): Mapping => ({
  customer_id: PICK,
  driver_id: Array.isArray(driver) ? "" : driver,
  smart_driver_id: Array.isArray(driver) ? driver : [],
  dropoff_id: "",
  first_name_last_name: "F - C - DC1 Tên",
  shift_start: start ? t(start) : null,
  shift_end: end ? t(end) : null,
  bot_token: "", chat_id: "", alt_drop_off_id: "",
  ...extra,
});
const cfg = (...mappings: Mapping[]) => ({ mappings }) as unknown as Config;
const at = (hm: string) => new Date(`2026-09-14T${hm}:00+07:00`);
const pick = (c: Config, hm: string, leave: LeaveEntry[] = [], dropoff = LAB) =>
  resolveDriverChoices(c, PICK, dropoff, leave, at(hm));
const ids = (r: ReturnType<typeof pick>) => JSON.stringify(r.ok ? r.drivers.map((d) => d.driverId) : r.reason);
const is = (...x: string[]) => JSON.stringify(x);

// ── The ±10 minute window ────────────────────────────────────────────────────
const day = cfg(row(A, "07:00", "12:00"), row(B, "12:00", "18:00"));
ok("a request at 12:00 offers both sides of a 12:00 handover", ids(pick(day, "12:00")) === is(A, B));
ok("11:50 does not reach B (B's first minute is 12:01)", ids(pick(day, "11:50")) === is(A));
ok("11:51 reaches B's first minute", ids(pick(day, "11:51")) === is(A, B));
ok("12:10 still reaches A's last minute", ids(pick(day, "12:10")) === is(A, B));
ok("12:11 no longer does", ids(pick(day, "12:11")) === is(B));
ok("a shift starting 10 minutes later is offered", ids(pick(cfg(row(A, "07:00", "14:00")), "06:55")) === is(A));
ok("a shift starting 11+ minutes later is not", ids(pick(cfg(row(A, "07:00", "14:00")), "06:45")) === JSON.stringify("no_driver"));
ok("a shift that ended 10 minutes ago is offered", ids(pick(cfg(row(A, "07:00", "14:00")), "14:10")) === is(A));
ok("a shift that ended 11 minutes ago is not", ids(pick(cfg(row(A, "07:00", "14:00")), "14:11")) === JSON.stringify("no_driver"));
ok("a wide gap stays a gap", ids(pick(cfg(row(A, "07:00", "11:00"), row(B, "13:00", "20:00")), "12:00")) === JSON.stringify("no_driver"));
ok("an overnight row answers after midnight", ids(pick(cfg(row(C, "22:00", "06:00")), "02:00")) === is(C));
ok("a blank window is all day", ids(pick(cfg(row(A)), "03:00")) === is(A));
ok("an empty window (start = end) covers nothing", ids(pick(cfg(row(A, "08:00", "08:00")), "08:00")) === JSON.stringify("no_driver"));
ok("no rows at all", ids(pick(cfg(), "10:00")) === JSON.stringify("no_mapping"));

// ── Union, destinations, redirects, proxies ──────────────────────────────────
ok("a pool offers every member once", ids(pick(cfg(row([P1, P2, P1], "06:00", "22:00")), "10:00")) === is(P1, P2));
ok("a pool member carries no name from the multi-name cell", (() => {
  const r = pick(cfg(row([P1], "06:00", "22:00")), "10:00"); return r.ok && r.drivers[0].name === null;
})());
ok("pool and fixed rows covering the window are both offered", ids(pick(cfg(row(A, "06:00", "22:00"), row([P1], "06:00", "22:00")), "10:00")) === is(A, P1));
ok("rows the engine would call a clash are both offered", ids(pick(cfg(row(A, "06:00", "14:00"), row(B, "12:00", "22:00")), "13:00")) === is(A, B));
ok("the same driver on two rows appears once", ids(pick(cfg(row(A, "06:00", "14:00"), row(A, "12:00", "22:00")), "13:00")) === is(A));
{
  const c = cfg(row(A, "06:00", "22:00"), row(B, "06:00", "22:00", { dropoff_id: HUB }));
  ok("a destination row replaces the blank row for its destination", ids(pick(c, "10:00", [], HUB)) === is(B));
  ok("the blank row still serves other destinations", ids(pick(c, "10:00", [], LAB)) === is(A));
}
ok("a redirecting row's driver is not offered", ids(pick(cfg(row(A, "", "", { alt_drop_off_id: HUB }), row(B)), "10:00")) === is(B));
ok("a proxy account is never offered", ids(pick(cfg(row([PROXY, P1], "06:00", "22:00")), "10:00")) === is(P1));
ok("a failed lookup in the id cell is never offered", ids(pick(cfg(row(["KHÔNG TÌM THẤY", P2], "06:00", "22:00")), "10:00")) === is(P2));

// ── Leave, read at the real clock ────────────────────────────────────────────
// Full-day rows for the real today: whatever time the test runs, they are in force.
const leave = (driver: string, subs: LeaveEntry["subs"] = []): LeaveEntry => ({
  driver_id: driver, driver_name: "F - C - DC9 Người Nghỉ", loai_nghi: "Nghỉ nguyên buổi",
  leave_from: vnDate(), leave_to: vnDate(), gio_bat_dau: null, gio_ket_thuc: null, subs,
});
ok("a driver on leave is replaced by their substitute",
  ids(pick(cfg(row(A)), "10:00", [leave(A, [{ id: SUB, name: "Người Thay", from: null, to: null }])])) === is(SUB));
ok("a driver on leave with no substitute is left out", ids(pick(cfg(row(A), row(B)), "10:00", [leave(A)])) === is(B));
ok("leave dated another day changes nothing",
  ids(pick(cfg(row(A)), "10:00", [{ ...leave(A), leave_from: "2999-01-01", leave_to: "2999-01-01" }])) === is(A));

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
