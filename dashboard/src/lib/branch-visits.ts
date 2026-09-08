/**
 * Reshapes one day of Cartrack routes into what a BRANCH needs to read.
 *
 * WHY THIS EXISTS — the branch feed is one card per job. On a shuttle run that is
 * unreadable: D021 sees sixteen near-identical cards from one courier who simply came
 * back fifteen times. Grouping the day by courier collapses that to one card
 * (measured 2026-08-31: p50 1 courier-card per branch, p90 2).
 *
 * TWO UNITS, DELIBERATELY.
 *   A VISIT is the unit of truth — the courier being at a place once, however many
 *   jobs they worked there. Merging by courier alone would claim one arrival where
 *   there were fifteen (45% of courier/place pairs are revisits, median 80 minutes
 *   apart), so visits are never flattened away.
 *   A COURIER is the unit of reading — the card. Its face answers "is someone coming
 *   and when"; the visits sit inside it.
 *
 * THE ORDER IS THE ONE THAT HAPPENED, for the part that has happened.
 *   Worked stops are sequenced by their own completion stamps, matching the TAT
 *   module's rule — a courier who re-sequenced their run must not be shown a history
 *   they did not ride. Only the still-pending tail is taken in the planned order,
 *   because for the future the plan is the only evidence there is. The two are cut
 *   separately and concatenated; they are never interleaved.
 *
 * Consecutive-run merging mirrors the TAT module (earliest arrival, latest completion,
 * attendance stops dropped first). Deliberately the same rule: two screens disagreeing
 * about what "one visit" means would be worse than either.
 */

import type { TimelineRoute, TimelineStop } from "./types";
import { stripDriverCode } from "./job-detail";

/** A chấm-công tap is a button press, not an arrival — counting one as a visit would
 *  invent a trip. Dropped before anything else, as the TAT module does. */
function isChamCong(s: TimelineStop): boolean {
  return (s.jobLabels ?? []).some((l) =>
    /chấm công|cham cong/i.test(typeof l === "string" ? l : (l?.label ?? ""))
  );
}

/**
 * Cartrack PLAN slots are not trips. A plan lays a courier's whole day out in advance
 * and regenerates every morning, so an untouched plan stop is a template, not a
 * commitment — 75% of every pending stop in the network is one (measured 2026-08-31:
 * 246 of 329). Left in, they inflate "đang tới đây" with samples nobody has agreed to
 * move and let the next-arrival estimate project off a slot that may never exist.
 *
 * DROPPED ONLY WHILE UNWORKED. /qr's job-level rule keeps a plan job only once the
 * whole job reaches status 5, which also discards a plan stop the courier demonstrably
 * stood on while the job is still open (6 stops today). For a history of visits that
 * is the wrong trade: a stop that happened is a fact whatever generated it. So the
 * test here is "did anyone work it", not "is the job finished".
 */
function isPlanGhost(s: TimelineStop): boolean {
  const planned = (s as unknown as { lastAssignedPlanId?: number | null }).lastAssignedPlanId != null;
  if (!planned) return false;
  return !ts(s.activityCompletedTs) && !ts(s.activityArrivedTs);
}

/** Everything this module refuses to treat as a stop. */
function isNoise(s: TimelineStop): boolean {
  return isChamCong(s) || isPlanGhost(s);
}

/** Identity of a place: customer id, falling back to coordinates truncated to ~1 m so
 *  GPS jitter at one address does not read as two places. */
function placeKey(s: TimelineStop): string {
  if (s.customerId) return "c:" + s.customerId;
  if (s.latitude != null && s.longitude != null) {
    return "p:" + s.latitude.toFixed(5) + "," + s.longitude.toFixed(5);
  }
  return "s:" + s.stopId;
}

const ts = (x: unknown): string | null =>
  typeof x === "string" && x.length >= 19 ? x.slice(0, 19) : null;
/** Cartrack stamp -> epoch ms. Exported so the screen parses stamps the one way. */
export const ms = (x: string | null): number | null => (x ? Date.parse(x.replace(" ", "T")) : null);

export interface VisitJob {
  job_id: number;
  stop_type_id: number; // 1 = collected here, otherwise handed over here
  /** This job's OTHER stop — where the sample goes, or where it came from. */
  counterpart: string | null;
  /** True once the job's far end is done, i.e. the branch's sample has landed. */
  settled: boolean;
}

export interface Visit {
  arrived: string | null;
  departed: string | null;
  /** No stamps at all — still ahead of the courier. */
  pending: boolean;
  jobs: VisitJob[];
}

export type LiveReason = "here" | "coming" | "carrying" | "done";

export interface CourierCard {
  driver_id: string | null;
  name: string | null;
  /** Where the branch stands with this courier — drives the one line on the card
   *  face. Anything but "done" means something is still riding on them. */
  reason: LiveReason;
  visits: Visit[];
  /** Typical minutes between this courier's visits here, once there are 3+. */
  cadenceMins: number | null;
  lastArrival: string | null;
}

export interface BranchDay {
  code: string;
  couriers: CourierCard[];
  totals: { jobs: number; couriers: number };
}

/** Cut one courier's stops into visits: the worked part in the order actually worked,
 *  the pending tail in planned order, concatenated. */
function cutVisits(stops: TimelineStop[]): TimelineStop[][] {
  const clean = stops.filter((s) => !isNoise(s));
  const worked = clean
    .filter((s) => ts(s.activityCompletedTs) || ts(s.activityArrivedTs))
    .sort((a, b) => {
      const A = ms(ts(a.activityCompletedTs) ?? ts(a.activityArrivedTs)) ?? 0;
      const B = ms(ts(b.activityCompletedTs) ?? ts(b.activityArrivedTs)) ?? 0;
      return A - B;
    });
  const pending = clean.filter((s) => !ts(s.activityCompletedTs) && !ts(s.activityArrivedTs));

  const runs: TimelineStop[][] = [];
  for (const part of [worked, pending]) {
    let i = 0;
    while (i < part.length) {
      let j = i;
      while (j + 1 < part.length && placeKey(part[j + 1]) === placeKey(part[i])) j++;
      runs.push(part.slice(i, j + 1));
      i = j + 1;
    }
  }
  return runs;
}

/** Route-level name, with the payroll-code prefix stripped ("F - P - DC100688 Nguyễn
 *  Minh Trung" -> "Nguyễn Minh Trung"), the same way every other branch-facing screen
 *  shows it. */
function courierName(r: TimelineRoute): string | null {
  const raw = (r as unknown as { driverFullname?: string }).driverFullname?.trim();
  return raw ? stripDriverCode(raw) : null;
}

export function buildBranchDay(routes: TimelineRoute[], code: string): BranchDay {
  // Every stop of every job, so a job's far end can be checked even when it sits on
  // another courier's route (a via-leg hands over mid-network).
  const jobStops = new Map<number, TimelineStop[]>();
  for (const r of routes) {
    for (const s of r.orderedStops ?? []) {
      jobStops.set(s.jobId, [...(jobStops.get(s.jobId) ?? []), s]);
    }
  }
  const farEndDone = (jobId: number, hereStopId: number): boolean => {
    const others = (jobStops.get(jobId) ?? []).filter((x) => x.stopId !== hereStopId);
    if (!others.length) return false;
    return others.every((x) => x.stopStatusId === 4 || x.stopStatusId === 5);
  };
  const farEndName = (jobId: number, hereStopId: number): string | null =>
    (jobStops.get(jobId) ?? []).find((x) => x.stopId !== hereStopId)?.customerName ?? null;

  const couriers: CourierCard[] = [];
  let totalJobs = 0;

  for (const r of routes) {
    // Noise is dropped inside cutVisits; a branch whose only stops are noise falls
    // out on the `mine.length === 0` guard below.
    const all = r.orderedStops ?? [];
    if (!all.some((s) => s.customerId === code)) continue;

    const runs = cutVisits(all);
    const mine: Visit[] = [];
    runs.forEach((group) => {
      if (group[0].customerId !== code) return;
      const arrived = group.map((s) => ts(s.activityArrivedTs)).filter(Boolean).sort()[0] ?? null;
      const completions = group.map((s) => ts(s.activityCompletedTs)).filter(Boolean).sort();
      mine.push({
        arrived,
        departed: completions.length ? completions[completions.length - 1]! : null,
        pending: !arrived && completions.length === 0,
        jobs: group.map((s) => ({
          job_id: s.jobId,
          stop_type_id: s.stopTypeId,
          counterpart: farEndName(s.jobId, s.stopId),
          settled: farEndDone(s.jobId, s.stopId),
        })),
      });
    });
    if (mine.length === 0) continue;

    // LIVE RULE — the branch still has something riding on this courier if a visit is
    // still ahead, one is open (arrived, not left), or a job worked here has not yet
    // reached its far end. That last clause is why a courier who drove away twenty
    // minutes ago stays at the top of the feed: the samples are in their van.
    const hasPending = mine.some((v) => v.pending);
    const hasOpen = mine.some((v) => !v.pending && v.arrived && !v.departed);
    const carrying = mine.some((v) => !v.pending && v.jobs.some((j) => !j.settled));
    const reason: LiveReason = hasOpen ? "here" : hasPending ? "coming" : carrying ? "carrying" : "done";

    // Cadence: only stated once there are three visits to average, and never published
    // as a clock time — measured error is p90 54 minutes.
    //
    // Falls back to the departure stamp, because many stops carry a completion without
    // an arrival: the courier taps "done" and never taps "arrived". Requiring a real
    // arrival left every D001 courier with no cadence at all, including one with ten
    // visits — the exact case the line exists to describe.
    const arrivals = mine
      .map((v) => ms(v.arrived ?? v.departed))
      .filter((x): x is number => x != null)
      .sort((a, b) => a - b);
    let cadenceMins: number | null = null;
    if (arrivals.length >= 3) {
      const gaps = arrivals.slice(1).map((x, k) => (x - arrivals[k]) / 60000);
      cadenceMins = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    }

    totalJobs += new Set(mine.flatMap((v) => v.jobs.map((j) => j.job_id))).size;
    couriers.push({
      driver_id: /^driver_(.+)$/.exec(r.routeId)?.[1] ?? null,
      name: courierName(r),
      reason,
      visits: mine,
      cadenceMins,
      lastArrival: mine.map((v) => v.arrived ?? v.departed).filter(Boolean).sort().pop() ?? null,
    });
  }

  // Imminence first: here now, then coming, then carrying away, then finished.
  const rank: Record<LiveReason, number> = { here: 0, coming: 1, carrying: 2, done: 3 };
  couriers.sort(
    (a, b) => rank[a.reason] - rank[b.reason] || (a.lastArrival ?? "").localeCompare(b.lastArrival ?? "")
  );

  return { code, couriers, totals: { jobs: totalJobs, couriers: couriers.length } };
}
