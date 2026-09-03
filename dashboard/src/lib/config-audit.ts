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
  /**
   * The 1-based sheet row, when the caller has it.
   *
   * Optional because the mapping this is usually handed does not carry one — a
   * row number on all ~1,700 parsed rows would grow the cached blob to label a
   * handful, the same reasoning that keeps branch NAMES out of it. The config
   * parse passes rows in because an overlap is only ACTIONABLE with them: the
   * fix is moving one boundary in one row, and a report that cannot say which
   * row is a sentence rather than a task.
   */
  row?: number;
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
// Only pairs where BOTH rows name a fixed driver: smart-assign rows RANK their
// candidates rather than competing, so a pool of them on one branch is the
// feature working, not a fault.
//
// Two rows naming the SAME driver used to be skipped here as "redundant, not
// ambiguous". That was wrong, and it hid the most common real case. The engine
// does not count DRIVERS, it counts ROWS: getDriversOnDuty returns "clash" the
// moment more than one row is on duty, whoever they name — so a branch with the
// same person on two overlapping rows has its jobs refused exactly like a branch
// with two different people, and nothing anywhere said so. Observed live on
// 2026-09-03: one branch, Đặng Khắc Huy 07:00–19:00 against Đặng Khắc Huy
// 15:15–19:30, CLASH at 18:30, and the dashboard's overlap list was empty.
//
// Refusing is the right call on the engine's side, and that is why this reports
// rather than the engine guessing: two rows for one person can still differ in
// alt_drop_off_id — which REWRITES where the job goes — so picking either would
// silently redirect real trips.

export interface ShiftOverlap {
  customer_id: string;
  /** The branch as it is written in the sheet. A supervisor reading this needs
   *  the place, not the id — the id is only what the rows are keyed by. */
  pickup_name: string;
  /** Display names of the two drivers, for a message a supervisor can act on. */
  drivers: [string, string];
  /** "HH:MM–HH:MM" — the stretch both rules claim. */
  window: string;
  /**
   * The two offending rows, when the input carried row numbers.
   *
   * This is what turns the report into something the dashboard can act on: each
   * side is exactly the shape `stretchOptions` already uses for a gap's
   * neighbours, so the same "move one boundary" flow works unchanged.
   */
  rules?: [OverlapSide, OverlapSide];
}

/** One side of an overlapping pair, in the shape the boundary-mover takes. */
export interface OverlapSide {
  row: number;
  driver: string;
  /** "HH:MM–HH:MM", or "" for a rule with no window (on duty all day). */
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
export function findShiftOverlaps(
  rows: readonly AuditableRow[],
  /** customer id → the branch's name in the sheet. Passed in rather than carried
   *  on every row: the parsed mapping does not hold the name, and adding it there
   *  would grow the cached blob for every one of ~1,700 rows to label a handful. */
  nameByCustomer?: ReadonlyMap<string, string>,
): ShiftOverlap[] {
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
        // NOT skipped when a.driver_id === b.driver_id — see the header. The
        // engine clashes on row count, so the same person twice blocks the job
        // just as hard, and usually means one row is a leftover.
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
        // Earlier rule first, so the pair always reads left to right in time and
        // "shorten the first / start the second later" means the same thing on
        // every row. A rule with no window sorts first: it is on duty from 00:00.
        const startOf = (r: AuditableRow) =>
          r.shift_start ? r.shift_start.hours * 60 + r.shift_start.minutes : -1;
        const [first, second] = startOf(a) <= startOf(b) ? [a, b] : [b, a];
        const sideWindow = (r: AuditableRow) =>
          r.shift_start && r.shift_end
            ? `${hhmm(r.shift_start.hours * 60 + r.shift_start.minutes)}–${hhmm(r.shift_end.hours * 60 + r.shift_end.minutes)}`
            : "";
        out.push({
          customer_id,
          pickup_name: nameByCustomer?.get(customer_id) ?? customer_id,
          drivers: [first.first_name_last_name || first.driver_id, second.first_name_last_name || second.driver_id],
          // Reported back in the sheet's own half-open terms, so the window
          // printed here is the one to type into the cell to fix it.
          window: `${hhmm(hit[0] - 1)}–${hhmm(hit[1])}`,
          ...(first.row != null && second.row != null
            ? {
                rules: [
                  { row: first.row, driver: first.first_name_last_name, window: sideWindow(first) },
                  { row: second.row, driver: second.first_name_last_name, window: sideWindow(second) },
                ] as [OverlapSide, OverlapSide],
              }
            : {}),
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

/**
 * Every pair, one per line — not a truncated sample.
 *
 * The other warnings summarise because they can run to hundreds of rows; this
 * one cannot usefully be shortened. Each pair is a separate boundary to move in
 * a different row, so a list ending in "and 2 more" names a problem while
 * withholding what is needed to fix it. Line breaks are preserved by the banner.
 */
//
// NOT on the dashboard banner any more — overlaps are rows in "Cần tạo config"
// with the boundary move offered on them. This formatter is kept for
// scripts/config-audit-live.mts, which prints the same audit as text.
export function shiftOverlapWarning(overlaps: readonly ShiftOverlap[]): string | null {
  if (overlaps.length === 0) return null;
  const lines = overlaps.map(
    (o) => `• ${o.pickup_name} — ${o.drivers[0]} / ${o.drivers[1]} · ${o.window}`,
  );
  return (
    `${overlaps.length} cặp dòng TRÙNG GIỜ cho cùng một điểm — hai tài xế cố định cùng trực, ` +
    `job rơi vào khoảng này sẽ báo CLASH và không được gán:\n${lines.join("\n")}`
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


// ── Which recorded gaps are still open ───────────────────────────────────────

/** A rule as the parse saw it, with the sheet row so a boundary can be moved. */
export interface RuleRow {
  row: number;
  driver: string;
  start: { hours: number; minutes: number } | null;
  end: { hours: number; minutes: number } | null;
}

const hhmmToMin = (v: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return -1;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : -1;
};

const win = (r: RuleRow): string =>
  r.start && r.end
    ? `${hhmm(r.start.hours * 60 + r.start.minutes)}–${hhmm(r.end.hours * 60 + r.end.minutes)}`
    : "cả ngày";

/** Whether any rule covers that minute. Uses the engine's own half-open window,
 *  via the same duty blocks the overlap check runs on, so "covered" here means
 *  exactly what it means when a job is assigned. */
export function isCovered(rules: readonly RuleRow[], atMin: number): boolean {
  return rules.some((r) =>
    dutyBlocks({ customer_id: "", driver_id: "", first_name_last_name: "", shift_start: r.start, shift_end: r.end })
      .some(([a, b]) => atMin >= a && atMin <= b),
  );
}

/**
 * Turn the recorded gaps into what a supervisor can act on, and say which are
 * now closed.
 *
 * The closed ones are the point: a gap disappears because the CONFIG says it is
 * covered, not because anyone retracted it. An alarm that can only be withdrawn
 * by whoever raised it outlives them.
 */
export function resolveGaps(
  recorded: readonly { customer_id: string; pickup_name: string; at: string; dropoff_name?: string }[],
  rulesByCustomer: ReadonlyMap<string, RuleRow[]>,
): { open: CoverageGapOut[]; closed: { customer_id: string; at: string }[] } {
  const open: CoverageGapOut[] = [];
  const closed: { customer_id: string; at: string }[] = [];
  // Same branch, same rules either side: one hole, however many minutes have
  // fallen into it. A gap is recorded at the MINUTE the job wanted, because that
  // is all the failing job knows — so a branch with a standing early booking
  // records 06:53 on Monday and 06:56 on Tuesday and would grow one to-do a day
  // for a single thing to fix. Collapsed here rather than at record time, which
  // cannot see the rules.
  const byHole = new Map<string, CoverageGapOut>();
  // Holes proven to serve more than one destination. Sticky: once two minutes
  // have named DIFFERENT places, a third naming one of them again must not
  // resurrect it as though the hole were single-destination.
  const mixedDropoff = new Set<string>();

  for (const g of recorded) {
    const at = hhmmToMin(g.at);
    const rules = rulesByCustomer.get(g.customer_id) ?? [];
    // A branch whose rules have all gone is not "covered" — it is a different
    // problem entirely, and dropping the record would hide it. Keep it open.
    if (at < 0 || (rules.length > 0 && isCovered(rules, at))) {
      closed.push({ customer_id: g.customer_id, at: g.at });
      continue;
    }
    // The cover that ends nearest BEFORE the hole, and the one starting nearest
    // after — the two rows whose boundary could be moved to close it.
    let before: RuleRow | null = null, after: RuleRow | null = null;
    for (const r of rules) {
      if (!r.start || !r.end) continue;
      const e = r.end.hours * 60 + r.end.minutes;
      const st = r.start.hours * 60 + r.start.minutes;
      if (e <= at && (!before || e > (before.end!.hours * 60 + before.end!.minutes))) before = r;
      if (st >= at && (!after || st < (after.start!.hours * 60 + after.start!.minutes))) after = r;
    }
    const hole = `${g.customer_id}|${before ? before.row : "-"}|${after ? after.row : "-"}`;
    const seen = byHole.get(hole);
    if (seen) {
      // Earliest minute is the headline; the rest stay as evidence that it
      // recurs, which is the difference between a one-off and a standing hole.
      const times = [seen.at, ...seen.also, g.at].sort();
      seen.at = times[0];
      seen.also = times.slice(1);
      // The destination survives the collapse only while no minute CONTRADICTS
      // it. One hole can swallow trips to two different labs, and showing
      // whichever happened to be recorded first would name a place this to-do is
      // not only about — so a real disagreement says nothing instead.
      //
      // Silence is not disagreement, and that distinction is the whole point:
      // every gap recorded before this field existed carries none, as does a job
      // with no dropoff stop. Treating those as a differing answer blanked any
      // hole holding even one older minute — which is every standing hole on the
      // day this shipped, and would have stayed that way until the config
      // covered it. An unknown minute now defers to a known one.
      const known = seen.dropoff_name, here = g.dropoff_name ?? "";
      if (!mixedDropoff.has(hole)) {
        if (!known) seen.dropoff_name = here;
        else if (here && here !== known) { mixedDropoff.add(hole); seen.dropoff_name = ""; }
      }
      continue;
    }
    const entry: CoverageGapOut = {
      customer_id: g.customer_id,
      pickup_name: g.pickup_name,
      dropoff_name: g.dropoff_name ?? "",
      at: g.at,
      also: [],
      before: before ? { row: before.row, driver: before.driver, window: win(before) } : null,
      after: after ? { row: after.row, driver: after.driver, window: win(after) } : null,
    };
    byHole.set(hole, entry);
    open.push(entry);
  }
  return { open, closed };
}

/** Local mirror of the published shape, to keep this module dependency-free. */
export interface CoverageGapOut {
  customer_id: string;
  pickup_name: string;
  /** Where the job was going, "" when unknown or not shared by every minute in
   *  the hole. Context for the panel only. */
  dropoff_name: string;
  at: string;
  /** Other minutes recorded against this same hole, earliest first. */
  also: string[];
  before: { row: number; driver: string; window: string } | null;
  after: { row: number; driver: string; window: string } | null;
}


/**
 * Whether existing rules already cover every minute of a window.
 *
 * What makes a written to-do row REDUNDANT. The engine creates one when a
 * branch has no rule at all; by the time anyone looks, the branch may have been
 * configured properly — by hand, or from this dashboard — and the empty row is
 * then just litter that reads as outstanding work. Row 1773 sat in the list
 * asking for a driver for 08:00–09:00 while row 407 had covered 05:00–18:00 all
 * along.
 *
 * Only rules that can actually assign count, which is why the caller passes the
 * usable ones: a second driverless row cannot cover anything.
 */
export function coversWindow(rules: readonly RuleRow[], from: string, to: string): boolean {
  const a = hhmmToMin(from), b = hhmmToMin(to);
  if (a < 0 || b < 0 || a === b) return false;
  // Half-open, as everywhere else: the window owns (a, b].
  const minutes: number[] = [];
  for (let m = a + 1; m !== (b + 1) % DAY; m = (m + 1) % DAY) {
    minutes.push(m);
    if (minutes.length > DAY) break;   // malformed input, never loop for ever
  }
  minutes.push(b);
  return minutes.every((m) => isCovered(rules, m));
}
