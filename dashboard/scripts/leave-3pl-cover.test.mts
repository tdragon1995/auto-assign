/**
 * A 3PL-express proxy in a substitute slot means "this lane runs on 3PL today",
 * not "nobody covers".
 *
 * Why this is worth a test. The proxy used to be filtered out of the substitute
 * list before anything was counted, so a row whose only sub was the proxy came
 * back indistinguishable from a row with no sub at all. Every caller then took
 * the missing-cover branch: the driver stayed in the smart pool, was never
 * actually tried, and still got named in the failure summary as "nghỉ giải
 * lao/offline" — a deliberate 3PL arrangement reported as an unstaffed lane
 * needing manual assignment (job 34428466, D015→D004, 2026-08-25).
 *
 * The proxy must still never be handed a job, so the fix is a third answer
 * rather than a different sub id. What this pins:
 *   - proxy alone            → "tpl"   (skip the driver, do NOT alarm)
 *   - no subs at all         → "none"  (skip the driver, DO alarm)
 *   - real sub + proxy       → "ok" on the real sub (half-updated row)
 *   - two real subs + proxy  → "clash" counting only the real two
 *   - proxy outside its window → "none" (an expired marker covers nothing)
 *   - the returned subId is never the proxy
 *
 * Pure arithmetic — no Redis, no network, no sheet:
 *
 *   npx tsx scripts/leave-3pl-cover.test.mts
 */

import { resolveSubstitute, PROXY_3PL_DRIVER_ID, type LeaveEntry, type SubEntry } from "../src/lib/leave-config";
import { vnMinutesSinceMidnight } from "../src/lib/time";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const sub = (id: string, from: string | null = null, to: string | null = null): SubEntry =>
  ({ id, name: id, from, to });

/** Full-day leave (no hour window) so every sub covers regardless of the clock. */
const leave = (subs: SubEntry[]): LeaveEntry => ({
  driver_id: "on-leave-driver",
  driver_name: "F - P - DC100075 Nguyễn Thế Đức",
  loai_nghi: "Nghỉ nguyên buổi",
  leave_from: "2026-08-25",
  leave_to: "2026-08-25",
  gio_bat_dau: null,
  gio_ket_thuc: null,
  subs,
});

const REAL_A = "aaaaaaaa-0000-0000-0000-000000000001";
const REAL_B = "bbbbbbbb-0000-0000-0000-000000000002";

console.log("resolveSubstitute — 3PL proxy as substitute\n");

// The live row that produced the false alarm.
check("proxy alone → tpl", resolveSubstitute(leave([sub(PROXY_3PL_DRIVER_ID)])).status, "tpl");

// Unchanged: a genuinely uncovered leave must still alarm.
check("no subs → none", resolveSubstitute(leave([])).status, "none");
check("blank sub id → none", resolveSubstitute(leave([sub("")])).status, "none");

// Real cover wins over the marker — the arrangement changed, the row is half-updated.
const mixed = resolveSubstitute(leave([sub(PROXY_3PL_DRIVER_ID), sub(REAL_A)]));
check("real sub + proxy → ok", mixed.status, "ok");
check("real sub + proxy → picks the real one", mixed.status === "ok" ? mixed.subId : null, REAL_A);

// The proxy is a marker, not a candidate: it must not inflate a clash.
const clash = resolveSubstitute(leave([sub(PROXY_3PL_DRIVER_ID), sub(REAL_A), sub(REAL_B)]));
check("two real subs + proxy → clash", clash.status, "clash");
check("clash counts only real subs", clash.status === "clash" ? clash.subIds.length : -1, 2);
check(
  "clash never lists the proxy",
  clash.status === "clash" ? clash.subIds.includes(PROXY_3PL_DRIVER_ID) : true,
  false,
);

// A single real sub alone is still the ordinary case.
const one = resolveSubstitute(leave([sub(REAL_A)]));
check("one real sub → ok", one.status, "ok");
check("one real sub → that id", one.status === "ok" ? one.subId : null, REAL_A);

// An expired marker covers nothing — the window rules apply to the proxy too,
// otherwise a morning-only 3PL arrangement would silence the lane all day.
const now = vnMinutesSinceMidnight();
const hhmm = (m: number) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, "0")}:${String(((m % 1440) + 1440) % 1440 % 60).padStart(2, "0")}`;
if (now >= 180 && now <= 1260) {
  // Window that closed an hour ago — safe to build only away from midnight.
  const expired = resolveSubstitute(leave([sub(PROXY_3PL_DRIVER_ID, hhmm(now - 120), hhmm(now - 60))]));
  check("proxy outside its window → none", expired.status, "none");
  const live = resolveSubstitute(leave([sub(PROXY_3PL_DRIVER_ID, hhmm(now - 60), hhmm(now + 60))]));
  check("proxy inside its window → tpl", live.status, "tpl");
} else {
  console.log("  skip  proxy window cases (clock too close to midnight to build a window)");
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
