/**
 * A substitute's return trip must still be bounded by their OWN shift window.
 *
 * Why this is worth a test. When a driver covers someone on leave, the return-trip
 * gate used to swap in the covered driver's shift and drop the sub's own. That
 * reads fine until the sub is covering at one branch while running their own
 * roster at another: at the second branch the covered driver has no mapping, the
 * lookup comes back EMPTY, and an empty lookup skips the shift check altogether.
 * No check means no closing time, so the return is rebuilt every cycle for the
 * rest of the day.
 *
 * That is not hypothetical. On 2026-08-22 a driver finished a D014 outbound at
 * 08:21 — 51 minutes after his 05:45–07:30 D014 window shut — and a return trip
 * was created for it at 09:21, then again each time it was removed. D014 carries
 * four fixed drivers and no smart pool, so the driver he was covering matched
 * nothing there. The same fault hit D033 on three separate days.
 *
 * The fix is a union: the sub's own windows at that PSC PLUS the covered driver's.
 * Both the creator and the cleanup sweep read it through one helper so the two
 * cannot drift — a return the creator would refuse is one the sweep should cancel.
 */
import { shiftMappingsForPsc, isOnShift } from "../src/lib/return-trips";
import type { Config, Mapping } from "../src/lib/types";

let failures = 0;
function ok(label: string, cond: boolean) {
  console.log(`  ${cond ? "ok  " : "FAIL"}   ${label}`);
  if (!cond) failures++;
}

const LUAT = "4894b938-0000-0000-0000-000000000001";
const HUY = "1fd87476-0000-0000-0000-000000000002";
const DUY = "a4f43b0a-0000-0000-0000-000000000003";
const HIEP = "412f31be-0000-0000-0000-000000000004";

const D014 = "customer-d014";
const D032 = "customer-d032";
const D007 = "customer-d007";

function mapping(
  customer_id: string,
  driver_id: string,
  smart: string[],
  start: string,
  end: string,
): Mapping {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return {
    customer_id,
    driver_id,
    smart_driver_id: smart,
    first_name_last_name: "",
    shift_start: { hours: sh, minutes: sm },
    shift_end: { hours: eh, minutes: em },
    bot_token: "",
    chat_id: "",
    alt_drop_off_id: "",
    dropoff_id: "",
  } as Mapping;
}

// D014: four fixed drivers, NO smart pool — the shape that caused the bug.
// D032: Luat's own early slot, then a pool slot he shares with Huy.
// D007: a pool branch belonging to Duy, whom Hiep covers.
const config = {
  mappings: [
    mapping(D014, LUAT, [], "05:45", "07:30"),
    mapping(D014, "other-driver-hoa", [], "07:30", "09:45"),
    mapping(D032, LUAT, [], "05:45", "07:00"),
    mapping(D032, "", [HUY, LUAT], "07:00", "15:15"),
    mapping(D032, HUY, [], "15:15", "18:45"),
    mapping(D007, "", [DUY], "09:00", "15:30"),
  ],
} as Config;

const at = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
};
const openAt = (ms: Mapping[], hhmm: string) => ms.some((m) => isOnShift(m, at(hhmm)));

console.log("1. The D014 regression: covering someone unmapped at this branch");
{
  const covering = new Map([[LUAT, HUY]]); // Luat covers Huy today
  const ms = shiftMappingsForPsc(config, D014, LUAT, covering);
  ok("his own D014 window is found, not discarded", ms.length === 1);
  ok("so the gate actually applies (non-empty)", ms.length > 0);
  ok("open inside his window (06:30)", openAt(ms, "06:30"));
  ok("SHUT at 08:21, when the outbound finished", !openAt(ms, "08:21"));
  ok("SHUT at 09:21, when the return was wrongly built", !openAt(ms, "09:21"));
}

console.log("2. Before the fix the same lookup was empty — no gate at all");
{
  const covering = new Map([[LUAT, HUY]]);
  const coveredOnly = config.mappings.filter(
    (m) => m.customer_id === D014 && (m.driver_id === HUY || m.smart_driver_id.includes(HUY)),
  );
  ok("covered driver alone matches nothing at D014", coveredOnly.length === 0);
  ok("union rescues it", shiftMappingsForPsc(config, D014, LUAT, covering).length > 0);
}

console.log("3. No regression where the covered driver IS mapped");
{
  const covering = new Map([[HIEP, DUY]]); // Hiep covers Duy
  const ms = shiftMappingsForPsc(config, D007, HIEP, covering);
  ok("Hiep inherits Duy's D007 window", ms.length === 1);
  ok("open at 13:36, when his return was built", openAt(ms, "13:36"));
  ok("shut at 08:00, before Duy's window", !openAt(ms, "08:00"));
}

console.log("4. Union really is both sides, not one or the other");
{
  const covering = new Map([[LUAT, HUY]]);
  const ms = shiftMappingsForPsc(config, D032, LUAT, covering);
  ok("all three D032 windows count", ms.length === 3);
  ok("his own early slot (06:00) is open", openAt(ms, "06:00"));
  ok("the shared pool slot (12:00) is open", openAt(ms, "12:00"));
  ok("Huy's late slot (16:00) is open while covering", openAt(ms, "16:00"));
  ok("still shut after every window (19:30)", !openAt(ms, "19:30"));
}

console.log("5. A driver covering nobody is unaffected");
{
  const none = new Map<string, string>();
  const ms = shiftMappingsForPsc(config, D014, LUAT, none);
  ok("own window only", ms.length === 1);
  ok("open 06:30", openAt(ms, "06:30"));
  ok("shut 09:21", !openAt(ms, "09:21"));
  ok("a stranger at this branch matches nothing", shiftMappingsForPsc(config, D014, DUY, none).length === 0);
}

console.log("");
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("All return-trip shift-window checks passed.");
