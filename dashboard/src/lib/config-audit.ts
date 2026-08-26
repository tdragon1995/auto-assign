/**
 * Things wrong with the config that nobody would otherwise notice.
 *
 * WHY THIS EXISTS. Every fault below is currently found the same way: a job
 * turns up, fails, and is reported as "customer not configured" — a message that
 * names the wrong culprit and only arrives once a pickup is already stuck. These
 * checks run when the config is parsed, so the same faults are named while the
 * sheet is still on screen and before any job depends on them.
 *
 * All of it is pure — rows in, sentences out — so a test can drive every branch
 * without touching the network. Step 2 of the config plan retires most of it:
 * a unique constraint refuses a duplicate name at the point of entry, and a
 * driver picker cannot produce a name that fails to resolve.
 */

/** Just enough of a parsed mapping row to audit it. */
export interface AuditableRow {
  customer_id: string;
  driver_id: string;
  first_name_last_name: string;
  shift_start: { hours: number; minutes: number } | null;
  shift_end: { hours: number; minutes: number } | null;
  /**
   * Which destination this row covers, blank meaning "any" — the per-destination
   * rule that lets one branch send to two places under two drivers.
   *
   * Optional because it is arriving separately: while every row is still blank
   * this changes nothing, and once the column is populated two rows pointed at
   * DIFFERENT destinations stop being reported, because they never compete for
   * the same job. Without this, the overlap check would start crying wolf on
   * exactly the arrangement that feature exists to allow.
   */
  dropoff_id?: string;
}

/** One place as the Location Table lists it. */
export interface LocationRow {
  customer_name: string;
  customer_id: string;
}

// ── Branch names that mean two different places ──────────────────────────────
//
// The workbook resolves a branch NAME to a branch id with a lookup, the same way
// it resolves a driver name. When one name appears twice pointing at two
// different Cartrack records, the lookup takes whichever sits higher in the
// sheet — arbitrarily, by row order — and the other record becomes unreachable
// through that name.
//
// Nothing notices. The engine never reads the Location Table; it sees only the id
// the lookup already produced, so the mapping row looks perfectly valid. The
// failure surfaces much later and in the wrong words. Measured on the live
// workbook 2026-08-26: 15 duplicated names, 5 of them clinics the mapping table
// covers.

export interface DuplicateBranch {
  name: string;
  /** The distinct ids this one name resolves to, in sheet order. The first is
   *  the one the workbook's lookup actually returns. */
  ids: string[];
  /** Whether the mapping table routes pickups for this name. A duplicate nobody
   *  collects from is untidy; one that IS collected from is a live trap. */
  usedAsPickup: boolean;
}

/**
 * Names appearing more than once with more than one id. Same place listed twice
 * under the same id is untidy but harmless — the lookup answers correctly either
 * way — so only differing ids are reported.
 *
 * `pickupNames` is passed in rather than fetched: the caller has just parsed the
 * mapping tab, and re-reading it would double a large download for nothing.
 */
export function findDuplicateBranches(
  rows: readonly LocationRow[],
  pickupNames: ReadonlySet<string>,
): DuplicateBranch[] {
  const byName = new Map<string, string[]>();
  for (const r of rows) {
    const name = (r.customer_name ?? "").trim();
    const id = (r.customer_id ?? "").trim();
    if (!name || !id) continue;
    const ids = byName.get(name);
    if (ids) {
      if (!ids.includes(id)) ids.push(id);   // distinct ids only, sheet order kept
    } else {
      byName.set(name, [id]);
    }
  }

  const dupes: DuplicateBranch[] = [];
  for (const [name, ids] of byName) {
    if (ids.length < 2) continue;
    dupes.push({ name, ids, usedAsPickup: pickupNames.has(name) });
  }

  // Collected-from ones first: those are the only ones that can strand a booking.
  return dupes.sort(
    (a, b) => Number(b.usedAsPickup) - Number(a.usedAsPickup) || a.name.localeCompare(b.name),
  );
}

// ── Two rules for one branch, live at the same minute ────────────────────────
//
// The engine already refuses to choose between them — it reports a clash and
// leaves the job alone. But it can only do that once a job exists, and the row
// pair has usually been sitting there for weeks. Overlap is decidable from the
// sheet alone.
//
// Deliberately conservative: only pairs where BOTH rows name a fixed driver, and
// two DIFFERENT drivers, are reported. Two rows for the same driver are
// redundant, not ambiguous, and smart-assign rows rank candidates rather than
// competing, so including either would cost false alarms on a warning whose whole
// value is that it is worth reading.

export interface ShiftOverlap {
  customer_id: string;
  /** Display names of the two drivers, for a message a supervisor can act on. */
  drivers: [string, string];
  /** "HH:MM–HH:MM" — the stretch both rules claim. */
  window: string;
}

const DAY = 24 * 60;

/**
 * Mirrors the engine's own driver-id test, deliberately duplicated rather than
 * imported: this module is pure by design and `config.ts` imports IT.
 *
 * The reason it is needed at all: a failed lookup in this workbook does not
 * always come back blank. Some cells carry the words "KHÔNG TÌM THẤY", which
 * pass any truthiness check and would count a broken row as a working rule —
 * the same trap that lets a `#N/A` leave row look like a real one.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const looksLikeDriverId = (v: string | undefined): boolean => UUID_RE.test((v ?? "").trim());

function hhmm(min: number): string {
  const m = ((min % DAY) + DAY) % DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * The minutes a row is on duty, as inclusive [from, to] blocks.
 *
 * Mirrors `isDriverOnShift` exactly, and the details matter: a blank window means
 * all day, the window is half-open so the start minute belongs to the OUTGOING
 * rule, and a start later than the end wraps past midnight. A row whose start
 * equals its end is on duty for no minute at all — faithful to the engine, which
 * would never pick it.
 */
function dutyBlocks(r: AuditableRow): Array<[number, number]> {
  if (!r.shift_start || !r.shift_end) return [[0, DAY - 1]];
  const s = r.shift_start.hours * 60 + r.shift_start.minutes;
  const e = r.shift_end.hours * 60 + r.shift_end.minutes;
  if (s === e) return [];
  if (s > e) return [[s + 1, DAY - 1], [0, e]];   // overnight
  return [[s + 1, e]];
}

function intersect(a: [number, number], b: [number, number]): [number, number] | null {
  const from = Math.max(a[0], b[0]);
  const to = Math.min(a[1], b[1]);
  return from <= to ? [from, to] : null;
}

/** Pairs of fixed-driver rules for the same branch that are both live at some
 *  minute of the day. One entry per offending pair. */
export function findShiftOverlaps(rows: readonly AuditableRow[]): ShiftOverlap[] {
  const byCustomer = new Map<string, AuditableRow[]>();
  for (const r of rows) {
    // Fixed-driver rules only, and only rules that actually name a driver: a cell
    // holding a failed-lookup string is a broken row, not a competing one, and is
    // reported separately rather than as an ambiguity.
    if (!r.customer_id || !looksLikeDriverId(r.driver_id)) continue;
    const list = byCustomer.get(r.customer_id);
    if (list) list.push(r); else byCustomer.set(r.customer_id, [r]);
  }

  const out: ShiftOverlap[] = [];
  for (const [customer_id, list] of byCustomer) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.driver_id === b.driver_id) continue;   // same person twice: redundant, not ambiguous
        // Rows covering different destinations never see the same job, so their
        // hours are free to overlap. Equal scopes DO compete — including two
        // blanks, which is every row today.
        if ((a.dropoff_id ?? "").trim() !== (b.dropoff_id ?? "").trim()) continue;
        let hit: [number, number] | null = null;
        for (const ba of dutyBlocks(a)) {
          for (const bb of dutyBlocks(b)) {
            const x = intersect(ba, bb);
            if (x && (!hit || x[0] < hit[0])) hit = x;
          }
        }
        if (!hit) continue;
        out.push({
          customer_id,
          drivers: [a.first_name_last_name || a.driver_id, b.first_name_last_name || b.driver_id],
          // Reported back in the sheet's own half-open terms, so the window
          // printed here is the one to type into the cell to fix it.
          window: `${hhmm(hit[0] - 1)}–${hhmm(hit[1])}`,
        });
      }
    }
  }
  return out;
}

// ── Lookups that no longer resolve ───────────────────────────────────────────

/** Rows carrying a name the workbook could not turn into an id. Both kinds are
 *  dropped at parse time, so neither can ever match a job — which is why they
 *  have to be said out loud here or not at all. */
export interface UnresolvedRows {
  /** "Điểm Pick-up" values that produced no branch id. */
  pickups: string[];
  /** Driver names that produced no id, on rows that DO have a branch. */
  drivers: string[];
  /** Rows whose driver cell holds something that is not an id at all — a failed
   *  lookup spelled out in words. The engine reports these per job as an invalid
   *  driver; naming them here means the cell can be fixed before that happens. */
  invalidDriverIds: string[];
  /**
   * "Điểm Drop-off" values that produced no destination id.
   *
   * The worst of the three, because the row is NOT dropped — it stays live and
   * simply loses its scope. A rule meant for one destination silently becomes a
   * rule for every destination, so it starts competing for jobs it was never
   * meant to take, and the only visible symptom is a clash somewhere else.
   */
  dropoffs: string[];
}

// ── Sentences ────────────────────────────────────────────────────────────────

/** How many names to spell out before the message just counts the rest. */
const NAMES_SHOWN = 3;

function list(names: readonly string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).join("; ");
  const rest = names.length - Math.min(names.length, NAMES_SHOWN);
  return rest > 0 ? `${shown} và ${rest} dòng nữa` : shown;
}

export function duplicateBranchWarning(dupes: readonly DuplicateBranch[]): string | null {
  const live = dupes.filter((d) => d.usedAsPickup);
  if (live.length === 0) return null;
  const others = dupes.length - live.length;
  const othersTail = others > 0 ? ` (thêm ${others} tên trùng chưa dùng làm điểm lấy mẫu)` : "";
  return (
    `${live.length} điểm lấy mẫu có TÊN TRÙNG trong Location Table, mỗi tên ra 2 mã khách khác nhau — ` +
    `sheet chỉ lấy mã nằm trên, mã còn lại sẽ báo "chưa cấu hình" khi có job: ${list(live.map((d) => d.name))}${othersTail}`
  );
}

export function shiftOverlapWarning(overlaps: readonly ShiftOverlap[]): string | null {
  if (overlaps.length === 0) return null;
  const shown = overlaps
    .slice(0, NAMES_SHOWN)
    .map((o) => `${o.customer_id} (${o.drivers[0]} / ${o.drivers[1]}, ${o.window})`);
  const rest = overlaps.length - Math.min(overlaps.length, NAMES_SHOWN);
  const tail = rest > 0 ? ` và ${rest} cặp nữa` : "";
  return (
    `${overlaps.length} cặp dòng TRÙNG GIỜ cho cùng một điểm — hai tài xế cố định cùng trực, ` +
    `job rơi vào khoảng này sẽ báo CLASH và không được gán: ${shown.join("; ")}${tail}`
  );
}

export function unresolvedWarning(u: UnresolvedRows): string | null {
  const parts: string[] = [];
  if (u.pickups.length) {
    parts.push(`${u.pickups.length} dòng có tên điểm nhưng KHÔNG ra mã khách: ${list(u.pickups)}`);
  }
  if (u.drivers.length) {
    parts.push(`${u.drivers.length} dòng có tên tài xế nhưng KHÔNG ra driver_id (thường do đổi tên trong Cartrack): ${list(u.drivers)}`);
  }
  if (parts.length === 0 && u.dropoffs.length === 0 && u.invalidDriverIds.length === 0) return null;

  // Split deliberately: the first two are rows that VANISH, the third is a row
  // that stays and quietly widens. Same cause, opposite symptom, different fix.
  const dropped = parts.length
    ? `${parts.join(" — ")}. Những dòng này bị bỏ qua, job sẽ báo "chưa cấu hình" dù nhìn trên sheet vẫn thấy.`
    : "";
  const broken = u.invalidDriverIds.length
    ? `${u.invalidDriverIds.length} dòng có driver_id KHÔNG phải là id (ô báo lỗi tra cứu) và cũng không có smart driver: ${list(u.invalidDriverIds)} — job ở những điểm này sẽ báo sai driver_id.`
    : "";
  const widened = u.dropoffs.length
    ? `${u.dropoffs.length} dòng có tên điểm giao nhưng KHÔNG ra dropoff_id: ${list(u.dropoffs)} — dòng vẫn chạy nhưng mất giới hạn điểm giao, sẽ nhận cả job đi nơi khác.`
    : "";
  return [dropped, broken, widened].filter(Boolean).join(" ");
}
