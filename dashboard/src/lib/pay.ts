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
 * COST: this module adds no Cartrack fetch of its own. It is handed the same
 * day of routes the TAT archive had already pulled, and its distance lookups go
 * through the same non-expiring Redis pair cache the payroll export has been
 * warming for months — so on the pairs that matter it is answered for free.
 */
import { roadDistancesForPairs } from "./distance-cache";
import { newFallbackState, type QuotaSignal } from "./distance";
import { isChamCong, CHAM_CONG_PREFIX } from "./job-filters";
import type { DistanceStats } from "./tat";
import type { TimelineRoute, TimelineStop } from "./types";

/** Đồng per hour clocked. */
export const RATE_PER_HOUR_VND = 30_000;
/** Đồng per kilometre ridden, pickup → dropoff. */
export const RATE_PER_KM_VND = 2_000;

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

export interface WorkedDay {
  /** Minutes the formula below counts as worked. */
  minutes: number;
  /** The spans that produced them, for showing the driver the working, in order. */
  spans: { from: string; to: string; minutes: number }[];
  /** A check-in with no check-out after it. Contributes NOTHING to `minutes` — a
   *  shift that was never closed has no recorded end, and inventing one would be
   *  paying against a guess. Surfaced so the driver can get it corrected rather
   *  than discover the hole on payday. */
  open_in: string[];
  /** A check-out with no check-in before it. Also contributes nothing; listed for
   *  the same reason. */
  stray_out: string[];
}

/**
 * ⚠ PROVISIONAL FORMULA — the payroll rule is still being settled, and this is
 * the ONLY place the pairing lives. Replacing it is a change to this function and
 * nothing else: the archive stores raw taps, `/api/pay/me` derives the minutes on
 * read, so a new rule applies to every past month the moment it deploys, with no
 * re-archive and no billed distance lookup behind it.
 *
 * What it does today: sort the day's taps by time, pair each check-in with the
 * next check-out, sum the pairs. Several pairs a day is normal and all of them
 * count — drivers check in and out at different PSCs across a shift, and the gap
 * between two shifts is not paid time.
 *
 * What it deliberately does NOT do: close an unpaired check-in at some plausible
 * later moment. There is no recorded end to that shift, and the difference
 * between a forgotten tap and a short one is not something this data can tell
 * apart. It counts zero and says so on screen.
 */
export function workedMinutes(punches: PayPunch[]): WorkedDay {
  const ordered = punches
    .map((p) => ({ kind: p.kind, at: punchAt(p) }))
    .filter((p): p is { kind: "in" | "out"; at: string } => p.at !== null)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const out: WorkedDay = { minutes: 0, spans: [], open_in: [], stray_out: [] };
  let open: string | null = null;

  for (const p of ordered) {
    if (p.kind === "in") {
      // Two check-ins in a row: the first was never closed. Keep the LATER one —
      // it is the shift that is actually running — and report the orphan.
      if (open) out.open_in.push(open);
      open = p.at;
      continue;
    }
    if (!open) { out.stray_out.push(p.at); continue; }
    const mins = Math.round((Date.parse(p.at) - Date.parse(open)) / 60_000);
    // A negative span means the taps landed out of order, which is not a
    // measurement. Dropped rather than clamped to zero, so it shows up as an
    // unpaired check-in instead of a silent 0-minute shift.
    if (mins > 0) {
      out.spans.push({ from: open, to: p.at, minutes: mins });
      out.minutes += mins;
    } else {
      out.open_in.push(open);
    }
    open = null;
  }
  if (open) out.open_in.push(open);

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

  const jobs: PayJob[] = [];
  for (const [jobId, jobStops] of byJob) {
    const pickup = jobStops.find((s) => Number(s.stopTypeId) === PICKUP_STOP);
    const dropoff = jobStops.find((s) => Number(s.stopTypeId) === DROPOFF_STOP);
    // A job with no real pickup→dropoff pair earns no kilometres, so it is not a
    // pay row at all. Single-stop (type 3) delivery jobs land here, as do the
    // half-jobs left when only one leg of a transport job reached this route.
    if (!pickup || !dropoff) continue;

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
