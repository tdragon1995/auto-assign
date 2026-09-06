/**
 * What a part-time driver earned: hours clocked, kilometres ridden, and the
 * đồng those come to.
 *
 * TWO RATES, TWO SOURCES
 *   30.000đ per hour, from the driver's own chấm-công check-in / check-out taps.
 *   2.000đ per kilometre, measured pickup → dropoff on each completed job.
 *
 * THE KILOMETRE IS A JOB'S PICKUP→DROPOFF, NOT A TAT LEG.
 *   These are different numbers and the difference is not small. A leg is the
 *   ride between two consecutive stops (see tat.ts): a driver collecting at three
 *   clinics before the lab run rides four legs while completing three jobs, and
 *   the leg kilometres exceed the job kilometres by every hop between clinics.
 *   The leg is what they actually rode; the job pickup→dropoff is what payroll
 *   pays, and it is the identical measure /api/export-completed has produced for
 *   the payroll CSV all along. Do not "fix" one to match the other.
 *
 * THE HOURS FORMULA IS PROVISIONAL — see workedMinutes().
 *   Which is why nothing here stores a minute count. The raw taps are archived
 *   and the arithmetic runs on read, so settling the formula later is a change to
 *   ONE function with no re-archive and no billed distance call behind it.
 *
 * WHAT A PAID KILOMETRE IS NOT. Three exclusions, all measured against
 * 15/07–14/08 before being written (5,260 completed pairs in that period):
 *   - a RETURN leg (`PSC_RETURN_LABEL`) carries nothing back — 28 jobs, 0.5%;
 *   - a VIA leg (`PSC_VIA_LABEL`) with no item tracking number collected
 *     nothing — 17 of the 115 via legs;
 *   - jobs that rode together, i.e. collected on ONE visit and delivered on ONE
 *     visit, are one ride and paid once — 37 jobs, 0.7%.
 * The third is the one to be careful with: grouping by driver+day+pair instead
 * of by visit collapses 36.7% of every job in the period, because the shuttle
 * runs repeat the same pair hourly and those are separate rides.
 *
 * COST: this module adds no Cartrack fetch of its own. It is handed the same
 * day of routes the TAT archive had already pulled, and its distance lookups go
 * through the same non-expiring Redis pair cache the payroll export has been
 * warming for months — so on the pairs that matter it is answered for free.
 */
import { roadDistancesForPairs } from "./distance-cache";
import { newFallbackState, type QuotaSignal } from "./distance";
import { isChamCong, CHAM_CONG_PREFIX, PSC_VIA_LABEL } from "./job-filters";
import { PSC_RETURN_LABEL } from "./return-trips";
import type { DistanceStats } from "./tat";
import type { TimelineRoute, TimelineStop } from "./types";

/** Đồng per hour clocked. */
export const RATE_PER_HOUR_VND = 30_000;
/** Đồng per kilometre ridden, pickup → dropoff. */
export const RATE_PER_KM_VND = 2_000;

/**
 * THE PAY PERIOD RUNS THE 15th TO THE 14th, NOT THE CALENDAR MONTH.
 *
 * This is the shape payroll actually pays on: the workbook
 * "2026.08_PT_Records_Vận_14.08" covers 15/07 – 14/08. So a period is KEYED BY
 * THE MONTH IT ENDS IN, which is how payroll names it, and `2026-08` means
 * 15 July to 14 August rather than the month of August.
 *
 * Getting this wrong is not cosmetic. A driver checking their earnings against
 * a payslip has to be looking at the same days, and a calendar month shares
 * neither end with the period they are paid for — it would disagree by roughly
 * two weeks at both ends, every single month, while looking perfectly plausible.
 *
 * Arithmetic is date-only and done in UTC so no timezone or DST shift can move a
 * boundary. The strings only ever feed date comparisons and PostgREST filters.
 */
export const PERIOD_END_DAY = 14;

const pad = (n: number) => String(n).padStart(2, "0");

/** Add whole months to a "YYYY-MM" key. */
export function shiftPayPeriod(period: string, delta: number): string {
  const d = new Date(`${period}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** Which period a day belongs to. The 14th closes a period; the 15th opens the
 *  next one, which is named for the month it will end in. */
export function payPeriodOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const key = `${y}-${pad(m)}`;
  return d <= PERIOD_END_DAY ? key : shiftPayPeriod(key, 1);
}

/** The inclusive day range a period covers. */
export function payPeriodRange(period: string): { from: string; to: string } {
  const prev = shiftPayPeriod(period, -1);
  return { from: `${prev}-${pad(PERIOD_END_DAY + 1)}`, to: `${period}-${pad(PERIOD_END_DAY)}` };
}

/** "15/07 – 14/08" — what the screens say instead of "Tháng 8", because naming a
 *  month for a span that is mostly the previous one is exactly the confusion this
 *  period shape causes. */
export function payPeriodLabel(period: string): string {
  const { from, to } = payPeriodRange(period);
  const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  return `${dm(from)} – ${dm(to)}`;
}

/** job_status_id 5 — Hoàn thành. Only a finished job is paid for. */
const COMPLETED_STATUS = 5;
/** stop_type_id 1 = pickup, 2 = dropoff. A single-stop (type 3) job has no pair. */
const PICKUP_STOP = 1;
const DROPOFF_STOP = 2;

/** One archived punch. Field names match the pay_punches columns exactly, so a row
 *  goes straight to PostgREST with no mapping layer in between. */
export interface PayPunch {
  trip_date: string;
  driver_id: string;
  driver_name: string | null;
  job_id: number;
  kind: "in" | "out";
  customer_id: string | null;
  location_name: string | null;
  /** All three stamps, exactly as Cartrack reported them. Stored rather than
   *  reduced to one "punch time" because which one payroll counts from is part of
   *  the formula that is still open. */
  started_ts: string | null;
  arrived_ts: string | null;
  completed_ts: string | null;
  job_status_id: number | null;
}

/** One archived paid job. Field names match the pay_jobs columns exactly. */
export interface PayJob {
  trip_date: string;
  driver_id: string;
  driver_name: string | null;
  job_id: number;
  reference_number: string | null;

  pickup_customer_id: string | null;
  pickup_name: string | null;
  pickup_lat: number | null;
  pickup_lng: number | null;
  pickup_completed_ts: string | null;

  dropoff_customer_id: string | null;
  dropoff_name: string | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  dropoff_completed_ts: string | null;

  distance_km: number | null;
}

/** Cartrack hands back VN-local wall time with no zone ("2026-08-12 14:31:07").
 *  Postgres timestamptz would read that as UTC and move every punch seven hours,
 *  so the offset is attached explicitly rather than left to be inferred. Same rule
 *  as tat.ts — kept local to this module so neither can quietly change for the
 *  other. */
function toIso(ts: string | null | undefined): string | null {
  if (!ts || typeof ts !== "string" || ts.length < 19) return null;
  return `${ts.slice(0, 10)}T${ts.slice(11, 19)}+07:00`;
}

const driverIdOf = (route: TimelineRoute): string | null => {
  const raw = (route as TimelineRoute & { routeId?: string }).routeId ?? "";
  const m = /^driver_(.+)$/.exec(raw);
  return m ? m[1] : null;
};

/** Stop labels arrive as plain strings from REST but as `{ labelId, label }`
 *  objects from JSON-RPC. Normalise to strings — the same normalisation
 *  `isChamCong` does, and needed here for the same payloads. */
function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((l) => (typeof l === "string" ? l : (l as { label?: unknown } | null)?.label))
    .filter((l): l is string => typeof l === "string");
}

/**
 * Which way a chấm-công tap points.
 *
 * The label is authoritative. The reference number is the fallback for a payload
 * carrying no labels at all — /api/cham-cong writes "Chấm Công - Vào" / "…- Ra",
 * so the suffix says it even when the labels do not. Anything that matches
 * neither is treated as a check-IN, because that is the tap that opens a shift
 * and a mislabelled open is visible on screen as an unclosed one, where a
 * mislabelled close would silently eat the shift before it.
 */
function punchKind(stop: TimelineStop): "in" | "out" {
  const labels = labelNames(stop.jobLabels);
  if (labels.includes("check_out")) return "out";
  if (labels.includes("check_in")) return "in";
  const ref = stop.referenceNumber ?? "";
  return ref.startsWith(CHAM_CONG_PREFIX) && /\bRa\s*$/.test(ref.trim()) ? "out" : "in";
}

/**
 * The instant a punch counts from: completion, else arrival, else the start of
 * the task.
 *
 * A chấm-công stop carries a 5-minute duration, so these disagree by a few
 * minutes. Completion is preferred because it is the stamp the driver's own
 * Chấm Công screen already shows them for a finished tap — the number on their
 * payslip should be the number they were looking at.
 *
 * This lives beside workedMinutes() rather than inside it because it is part of
 * the same provisional formula, and both are replaced together.
 */
export function punchAt(p: Pick<PayPunch, "started_ts" | "arrived_ts" | "completed_ts">): string | null {
  return p.completed_ts ?? p.arrived_ts ?? p.started_ts ?? null;
}

/** The contracted window a driver was rostered for on one day, VN local "HH:MM".
 *
 *  NOT derived from the taps — this is the roster's answer to "when were they
 *  meant to work", and the payroll rule leans on it in both directions (see
 *  workedMinutes). `source` travels so a disputed day can say WHICH roster
 *  answered: a Sunday shift, a substitution, or the standing contract. */
export interface ShiftWindow {
  start: string | null;
  end: string | null;
  source: "sunday" | "sub" | "contract" | null;
}

/** Everything about a driver's day that is NOT a chấm-công tap but still shapes
 *  the clock. Passed in rather than looked up, so the pairing rule stays a pure
 *  function and the (harder, still-unsettled) question of where a shift window
 *  comes from is answered by the caller. */
export interface DayFacts {
  shift: ShiftWindow;
  /** ISO instant of the day's LAST completed delivery — the workbook's
   *  "Last Task". This is half of the check-out clock, not a nicety. */
  lastTaskAt: string | null;
  /** ISO instant of the day's FIRST task. Used only when a check-in tap is
   *  missing, which is ~3% of days. */
  firstTaskAt: string | null;
}

export const NO_SHIFT: ShiftWindow = { start: null, end: null, source: null };

export interface WorkedDay {
  /** Minutes the rule below counts as worked. */
  minutes: number;
  /** The two clocks actually used, "HH:MM", so a driver can check the sum. */
  in_at: string | null;
  out_at: string | null;
  /** What each clock was taken from — the whole point of showing the working. */
  in_basis: "tap" | "shift_start" | "first_task" | null;
  out_basis: "shift_end" | "last_task" | "tap" | null;
  /** No roster window was available, so the day fell back to raw taps. The
   *  number is then a best effort, not the payroll rule, and must say so. */
  missing_shift: boolean;
  /** A check-in tap with no check-out. Under THIS rule it no longer costs the
   *  driver anything — the clock runs to the shift end regardless — so it is
   *  reported as a record to tidy, not as lost pay. */
  open_in: string[];
  stray_out: string[];
  /** out < in. Should be impossible; kept visible rather than clamped silently. */
  inverted: boolean;
}

/** "HH:MM" (or an ISO instant) → minutes since VN midnight. Null if unparseable. */
function minsOfDay(v: string | null): number | null {
  if (!v) return null;
  const hhmm = /^(\d{1,2}):(\d{2})/.exec(v);
  if (hhmm) return Number(hhmm[1]) * 60 + Number(hhmm[2]);
  const iso = /T(\d{2}):(\d{2})/.exec(v);
  if (iso) return Number(iso[1]) * 60 + Number(iso[2]);
  return null;
}

const hhmmOf = (mins: number | null): string | null =>
  mins == null ? null : `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

/**
 * A day's paid minutes, following the rule the payroll workbook actually applies
 * (2026.08_PT_Records, sheets "Driver Daily Report" + "Final Report").
 *
 * THE CONTRACTED SHIFT IS A FLOOR AND A CEILING. That is the whole rule, and it
 * is not what a naive reading of "clock in, clock out" gives you:
 *
 *   in  = MAX(check-in tap, shift start)      early arrival earns nothing
 *   out = MAX(shift end, last completed task) you are paid to the end of the
 *                                             shift even if you stopped early,
 *                                             and past it only as far as real work
 *
 * THE CHECK-OUT TAP IS ALMOST NEVER USED. Verified against 1,074 computed rows:
 * whenever a shift end and a last task both exist, the workbook takes MAX of
 * those two and DISCARDS the tap — including taps that were plainly wrong (a
 * 15:00 tap on a shift ending 21:00 paid to 21:15; a 22:01 tap capped at 21:13).
 * The tap survives only when one of the three values is missing.
 *
 * WHICH MEANS A FORGOTTEN CHECK-OUT COSTS NOTHING. The previous implementation
 * paid ZERO for an unclosed shift, on the reasoning that its end was unknowable.
 * Against this data that would have zeroed 51 of 1,076 driver-days (5%), plus 29
 * more with no check-in (3%) — roughly 7% of everyone's month, all of it wrong.
 * The roster knows when the shift ended; the tap was never the authority.
 *
 * WITHOUT A SHIFT WINDOW it degrades to raw taps (tap-in → tap-out, falling back
 * to first/last task) and sets `missing_shift`. That is not the payroll rule and
 * the screen must not present it as one — but it is far closer than paying zero,
 * so an unsourced day is under-informed rather than unpaid.
 *
 * ONE SPAN PER DAY, not a sum of pairs. Since the close is driven by the roster
 * and the last task, several taps in a day collapse into one window — which is
 * what the workbook does (it matches the FIRST tap of each kind) and the opposite
 * of the old rule, which summed every in/out pair and so refused to pay the gap
 * between two shifts. If split shifts must each be paid separately, this is the
 * function that has to change, and the workbook does not do it today.
 */
export function workedMinutes(punches: PayPunch[], facts: DayFacts = { shift: NO_SHIFT, lastTaskAt: null, firstTaskAt: null }): WorkedDay {
  const stamped = punches
    .map((p) => ({ kind: p.kind, at: punchAt(p) }))
    .filter((p): p is { kind: "in" | "out"; at: string } => p.at !== null)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const ins = stamped.filter((p) => p.kind === "in");
  const outs = stamped.filter((p) => p.kind === "out");

  // EARLIEST of each kind. The workbook takes whichever row MATCH happens to hit
  // first, which is sheet order and therefore arbitrary; earliest-by-clock is the
  // same answer on every well-formed day and a defensible one on the rest.
  const tapIn = ins[0]?.at ?? null;
  const tapOut = outs[0]?.at ?? null;

  const shiftStart = minsOfDay(facts.shift.start);
  const shiftEnd = minsOfDay(facts.shift.end);
  const lastTask = minsOfDay(facts.lastTaskAt);
  const firstTask = minsOfDay(facts.firstTaskAt);
  const tapInM = minsOfDay(tapIn);
  const tapOutM = minsOfDay(tapOut);

  const out: WorkedDay = {
    minutes: 0, in_at: null, out_at: null, in_basis: null, out_basis: null,
    missing_shift: shiftStart == null || shiftEnd == null,
    // Every tap that did not pair off, so the record can still be tidied even
    // though the money no longer depends on it.
    open_in: ins.slice(tapOut ? 1 : 0).map((p) => p.at),
    stray_out: outs.slice(1).map((p) => p.at),
    inverted: false,
  };

  // ── The in-clock: later of when they showed up and when the shift began ──
  const rawIn = tapInM ?? firstTask;
  const rawInBasis: WorkedDay["in_basis"] = tapInM != null ? "tap" : firstTask != null ? "first_task" : null;
  let inM: number | null = rawIn;
  if (rawIn != null && shiftStart != null && shiftStart > rawIn) {
    inM = shiftStart;
    out.in_basis = "shift_start";
  } else {
    out.in_basis = rawInBasis;
  }

  // ── The out-clock: later of the shift end and the last real work ──
  let outM: number | null;
  if (shiftEnd != null && lastTask != null) {
    outM = Math.max(shiftEnd, lastTask);
    out.out_basis = outM === lastTask && lastTask > shiftEnd ? "last_task" : "shift_end";
  } else {
    // One of the two is missing, so fall back exactly as the workbook does:
    // the tap, then the last task.
    outM = tapOutM ?? lastTask;
    out.out_basis = tapOutM != null ? "tap" : lastTask != null ? "last_task" : null;
  }

  out.in_at = hhmmOf(inM);
  out.out_at = hhmmOf(outM);

  if (inM == null || outM == null) return out;
  if (outM < inM) {
    // Never seen in the payroll data and not something to guess at: an overnight
    // shift and a mis-stamped day look identical from here. Reported, paid zero.
    out.inverted = true;
    return out;
  }
  out.minutes = outM - inM;
  return out;
}

/** Đồng earned for a span of clocked minutes. Per MINUTE, not per whole hour:
 *  30.000đ/h is exactly 500đ a minute, so this needs no rounding rule of its own
 *  and a 20-minute shift is not rounded away to nothing. */
export const hourPayFor = (minutes: number): number =>
  Math.round((minutes / 60) * RATE_PER_HOUR_VND);

/** Đồng earned for a distance.
 *
 *  TOTALS MULTIPLY THE SUMMED KILOMETRES, they never add up per-job đồng. Each
 *  job's figure is this function rounded to the đồng for display; adding thirty
 *  of those instead would drift from the total by up to fifteen đồng, and a
 *  payslip whose lines do not add to its own total is a payslip nobody trusts.
 *  So: sum km first, price once. */
export const kmPayFor = (km: number): number => Math.round(km * RATE_PER_KM_VND);

/**
 * One driver's day of routes → the rows to archive.
 *
 * Jobs are grouped by job_id rather than read off consecutive stops, because a
 * job's pickup and its dropoff are frequently NOT consecutive on the route: the
 * driver collects at several clinics before running the lot to the lab. Pairing
 * by position would invent trips between other people's clinics.
 */
export function payRowsForRoute(
  route: TimelineRoute,
  tripDate: string,
): { jobs: PayJob[]; punches: PayPunch[] } {
  const driverId = driverIdOf(route);
  if (!driverId) return { jobs: [], punches: [] };

  const driverName =
    (route as TimelineRoute & { driverFullname?: string | null }).driverFullname ?? null;

  const stops = route.orderedStops ?? [];
  const punches: PayPunch[] = [];
  const byJob = new Map<number, TimelineStop[]>();

  for (const s of stops) {
    const asJob = s as unknown as { referenceNumber?: string | null; jobLabels?: unknown };
    if (isChamCong(asJob)) {
      punches.push({
        trip_date: tripDate,
        driver_id: driverId,
        driver_name: driverName,
        job_id: Number(s.jobId),
        kind: punchKind(s),
        customer_id: s.customerId ?? null,
        location_name: s.customerName ?? null,
        started_ts: toIso(s.activityStartedTs),
        arrived_ts: toIso(s.activityArrivedTs),
        completed_ts: toIso(s.activityCompletedTs),
        job_status_id: Number.isFinite(Number(s.jobStatusId)) ? Number(s.jobStatusId) : null,
      });
      continue;
    }
    // Only a finished job is paid for. Checked on the STOP's copy of the job
    // status, which is what the timeline carries — there is no job object here.
    if (Number(s.jobStatusId) !== COMPLETED_STATUS) continue;
    const id = Number(s.jobId);
    if (!Number.isFinite(id)) continue;
    const list = byJob.get(id);
    if (list) list.push(s); else byJob.set(id, [s]);
  }

  // ── Which VISIT each stop belongs to ──────────────────────────────────────
  // Consecutive stops at the same place are ONE visit — the same rule tat.ts
  // uses. Two jobs collected on one visit and delivered on one visit are one
  // ride, and a ride is paid once however many jobs rode along.
  //
  // A time window was considered and rejected on measurement: grouping by
  // driver+day+pair alone collapses 36.7% of all jobs, because the shuttle runs
  // repeat the same pair hourly all afternoon (15:19, 16:46, 17:40, 20:52 …) and
  // those are separate rides. Consecutiveness collapses 0.7%, which is the real
  // number of merged visits, and needs no magic threshold.
  const visitOf = new Map<number, number>();
  {
    const ordered = stops
      .filter((s) => !isChamCong(s as unknown as { referenceNumber?: string | null; jobLabels?: unknown }))
      .map((s) => ({ s, at: toIso(s.activityCompletedTs) }))
      .filter((e): e is { s: TimelineStop; at: string } => e.at !== null)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    let idx = -1;
    let prevPlace: string | null = null;
    for (const { s } of ordered) {
      const place = `${s.customerId ?? ""}|${s.latitude},${s.longitude}`;
      if (place !== prevPlace) { idx++; prevPlace = place; }
      visitOf.set(Number(s.stopId), idx);
    }
  }

  const jobs: PayJob[] = [];
  /** One paid ride per (pickup visit → dropoff visit). */
  const ridePaid = new Set<string>();

  for (const [jobId, jobStops] of byJob) {
    const pickup = jobStops.find((s) => Number(s.stopTypeId) === PICKUP_STOP);
    const dropoff = jobStops.find((s) => Number(s.stopTypeId) === DROPOFF_STOP);
    // A job with no real pickup→dropoff pair earns no kilometres, so it is not a
    // pay row at all. Single-stop (type 3) delivery jobs land here, as do the
    // half-jobs left when only one leg of a transport job reached this route.
    if (!pickup || !dropoff) continue;

    const labels = labelNames(dropoff.jobLabels ?? pickup.jobLabels);

    // ── RETURN TRIPS ARE NOT PAID ─────────────────────────────────────────
    // The run back from the lab carries nothing. It is a real ride and it is
    // already counted as distance by the TAT report, which measures what was
    // ridden; pay measures what was delivered, and this delivered nothing.
    if (labels.includes(PSC_RETURN_LABEL)) continue;

    // ── A VIA LEG IS PAID ONLY IF IT ACTUALLY CARRIED A BATCH ─────────────
    // A "ghé" leg is a deliberate second pickup on an existing run. With a
    // tracking number it moved samples and is a delivery like any other;
    // without one nothing was collected, so there is nothing to pay for.
    if (labels.includes(PSC_VIA_LABEL)) {
      const carried = [pickup, dropoff].some(
        (st) => Array.isArray(st.itemTrackingNumbers) && st.itemTrackingNumbers.length > 0,
      );
      if (!carried) continue;
    }

    // ── MERGED STOPS ARE ONE RIDE ─────────────────────────────────────────
    // Jobs collected on the same visit and delivered on the same visit rode
    // together. The first one carries the distance; the rest are dropped rather
    // than priced at zero, because a 0 km row on the driver's screen reads as a
    // measurement failure rather than "this was the same trip".
    const pv = visitOf.get(Number(pickup.stopId));
    const dv = visitOf.get(Number(dropoff.stopId));
    if (pv != null && dv != null) {
      const ride = `${pv}>${dv}`;
      if (ridePaid.has(ride)) continue;
      ridePaid.add(ride);
    }

    jobs.push({
      trip_date: tripDate,
      driver_id: driverId,
      driver_name: driverName,
      job_id: jobId,
      reference_number: dropoff.referenceNumber ?? pickup.referenceNumber ?? null,

      pickup_customer_id: pickup.customerId ?? null,
      pickup_name: pickup.customerName ?? null,
      pickup_lat: Number.isFinite(pickup.latitude) ? pickup.latitude : null,
      pickup_lng: Number.isFinite(pickup.longitude) ? pickup.longitude : null,
      pickup_completed_ts: toIso(pickup.activityCompletedTs),

      dropoff_customer_id: dropoff.customerId ?? null,
      dropoff_name: dropoff.customerName ?? null,
      dropoff_lat: Number.isFinite(dropoff.latitude) ? dropoff.latitude : null,
      dropoff_lng: Number.isFinite(dropoff.longitude) ? dropoff.longitude : null,
      dropoff_completed_ts: toIso(dropoff.activityCompletedTs),

      distance_km: null,
    });
  }

  // Oldest first, so a day reads down the page in the order it was worked.
  jobs.sort((a, b) => Date.parse(a.dropoff_completed_ts ?? "") - Date.parse(b.dropoff_completed_ts ?? ""));
  return { jobs, punches };
}

/**
 * Price every job's pickup→dropoff in ONE roadDistancesForPairs call, which dedupes
 * the pairs and answers from the non-expiring Redis cache before touching Goong.
 *
 * These are the very pairs /api/export-completed has been resolving month after
 * month for the payroll CSV, into this same cache — so on a fleet that has run
 * that export even once, the bulk of a day is already answered and costs nothing.
 * Only a genuinely new pair is ever billed, and it is billed once.
 *
 * A job whose stop carries no coordinates is left unpriced rather than haversined.
 * An unpriced job is honest and visible; one paid against a straight-line guess is
 * neither, and this is somebody's wage.
 */
export async function attachPayDistances(jobs: PayJob[]): Promise<DistanceStats> {
  const stats: DistanceStats = { pairs: 0, cache: 0, api: 0, self: 0, failed: 0, noCoords: 0 };
  const measurable = jobs.filter(
    (j) => j.pickup_lat != null && j.pickup_lng != null && j.dropoff_lat != null && j.dropoff_lng != null,
  );
  stats.noCoords = jobs.length - measurable.length;
  if (measurable.length === 0) return stats;

  // One brake per provider for the whole day, exactly as the leg archive does:
  // without it a provider that has already cut us off is re-asked for every
  // remaining pair, and the day is lost to 429s. Separate signals because either
  // provider going quiet must not silence the other.
  const signal: QuotaSignal = { quotaExceeded: false };
  const fallback = newFallbackState();
  const results = await roadDistancesForPairs(
    measurable.map((j) => ({
      from: { lat: j.pickup_lat!, lon: j.pickup_lng! },
      to: { lat: j.dropoff_lat!, lon: j.dropoff_lng! },
    })),
    undefined,
    signal,
    fallback,
  );

  measurable.forEach((job, i) => {
    stats.pairs++;
    const r = results[i];
    if (!r) { stats.failed++; return; }
    if (r.source === "cache") stats.cache++;
    else if (r.source === "api") stats.api++;
    else stats.self++;

    const km = r.distance_km ?? null;
    if (km == null) { stats.failed++; return; }
    job.distance_km = Math.round(km * 100) / 100;
  });

  return stats;
}

/** The whole pipeline for one day: routes in, priced pay rows out. Shared by the
 *  archiver and any caller that wants a day without persisting it. */
export async function buildDayPay(
  routes: TimelineRoute[],
  tripDate: string,
): Promise<{ jobs: PayJob[]; punches: PayPunch[]; stats: DistanceStats }> {
  const jobs: PayJob[] = [];
  const punches: PayPunch[] = [];
  for (const r of routes) {
    const rows = payRowsForRoute(r, tripDate);
    jobs.push(...rows.jobs);
    punches.push(...rows.punches);
  }
  const stats = await attachPayDistances(jobs);
  return { jobs, punches, stats };
}
