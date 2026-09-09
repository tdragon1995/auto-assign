/**
 * A substitute who is already busy.
 *
 * Naming a substitute says "B covers A's branches while A is off". It does not
 * say anything about B's OWN branches, and B usually has some — so the pairing
 * that quietly goes wrong is B being the fixed driver of their own route at the
 * same hours they have just been handed A's. The sheet accepts it, the engine
 * accepts it, and the day fails on the road.
 *
 * So the write is allowed and a WARNING comes back with it. Not a refusal: this
 * is routinely deliberate — a quiet branch and a busy one are one person's
 * morning, and the supervisor knows that where the engine does not. What they
 * cannot do is notice it from a name in a combobox.
 *
 * IT ONLY COUNTS A FIXED ROW, AND ONLY WHERE THE HOURS MEET.
 *
 *   A fixed `driver_id` is a duty: that branch has one driver and it is this
 *   person. Membership of a `smart_driver_id` list is not — it is one candidate
 *   among several, which is how most work is spread, so warning on it would fire
 *   on nearly every substitute ever named and the warning would stop being read.
 *
 *   And the hours have to actually meet. Someone whose own route runs 06:00 to
 *   10:00 covering an afternoon absence is not conflicted, and saying so anyway
 *   is the same noise by another route.
 */
import type { Mapping } from "./types";
import { dutyBlocks } from "./config-audit";
import { driverDisplayName } from "./display-names";

type Block = [number, number];

/** `"13:30"` → 810; -1 for anything unparseable. */
function toMin(t: string | null | undefined): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((t ?? "").trim());
  if (!m) return -1;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins < 24 * 60 ? mins : -1;
}

/** `"06:30–15:00"` → the pair, or null for a whole day. The en dash is the one
 *  `coverageOnDate` builds; a hyphen is accepted too because these labels are
 *  also typed by hand into the sheet. */
export function parseWindowLabel(label: string | null | undefined): { start: string; end: string } | null {
  const parts = (label ?? "").split(/[–-]/);
  if (parts.length !== 2) return null;
  const [start, end] = parts.map((p) => p.trim());
  return toMin(start) >= 0 && toMin(end) > toMin(start) ? { start, end } : null;
}

/** The branches this driver is the FIXED driver of, whose hours meet `window`
 *  (null = the whole day). Customer ids, in sheet order, de-duplicated. */
export function busyBranches(
  driverId: string,
  window: { start: string; end: string } | null,
  mappings: readonly Mapping[],
): string[] {
  const id = (driverId ?? "").trim();
  if (!id) return [];
  const from = window ? toMin(window.start) : 0;
  const to = window ? toMin(window.end) : 24 * 60 - 1;
  if (from < 0 || to <= from) return [];

  const hit = new Set<string>();
  for (const m of mappings) {
    if (m.driver_id !== id) continue;
    // (from, to] — half-open at the start, the convention the engine and
    // `dutyBlocks` share, so a rule handing over on the boundary minute is not
    // counted as a clash.
    const meets = dutyBlocks(m).some(([s, e]: Block) => Math.max(s, from + 1) <= Math.min(e, to));
    if (meets && m.customer_id) hit.add(m.customer_id);
  }
  return [...hit];
}


/**
 * The sentence to hand back with the write, or null when nothing is in the way.
 *
 * Every conflicting substitute in ONE line: two of them is a worse day than one,
 * and two toasts is a thing people dismiss without reading the second.
 */
export function subDutyWarning(
  subs: readonly { name: string; driver_id: string; from: string | null; to: string | null }[],
  leaveWindow: { start: string; end: string } | null,
  mappings: readonly Mapping[],
): string | null {
  const clashes: string[] = [];
  for (const s of subs) {
    // A sub with its own window covers only that slice; without one it inherits
    // the leave's hours, which is what the sheet means by a blank window.
    const window = s.from && s.to ? { start: s.from, end: s.to } : leaveWindow;
    const branches = busyBranches(s.driver_id, window, mappings);
    if (branches.length === 0) continue;
    // A COUNT, not a list. `customer_id` is a Cartrack uuid — the config table
    // carries the readable branch name in a column this route does not load —
    // so naming them would print forty uuids and say less than the number does.
    clashes.push(`${driverDisplayName(s.name) || s.name} (${branches.length} tuyến)`);
  }
  if (clashes.length === 0) return null;
  return (
    `Người thay cũng đang có tuyến cố định trong khung giờ này: ${clashes.join("; ")}. ` +
    `Cần bố trí người thay cho chính họ, hoặc kiểm tra lại giờ.`
  );
}


/** One actionable warning for one substitute on the displayed day. */
export interface SubDutyConflict {
  driver_id: string;
  name: string;
  date: string;
  from: string | null;
  to: string | null;
  branches: number;
}

export function subDutyConflicts(
  subs: readonly { id: string; name: string; from: string | null; to: string | null }[],
  leaveWindow: { start: string; end: string } | null,
  date: string,
  mappings: readonly Mapping[],
): SubDutyConflict[] {
  return subs.flatMap((sub) => {
    const window = sub.from && sub.to ? { start: sub.from, end: sub.to } : leaveWindow;
    const branches = busyBranches(sub.id, window, mappings).length;
    return branches ? [{
      driver_id: sub.id, name: sub.name, date,
      from: window?.start ?? null, to: window?.end ?? null, branches,
    }] : [];
  });
}
