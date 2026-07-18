import type { Config, Driver, FailedJob, Job, LogEntry, LogLevel, Mapping, PickupWarning, TimelineRoute } from "./types";
import { getDrivers, getAllAssignedDriverJobs, assignJob, assignJobViaUpdate, getCustomerById, updateJobStops, updateJobSendToDriverAt, updateJobScheduledDeliveryTs, unassignJob, optimizeDriverRoute, getJobsByStatusAndDate, getUnassignedJobsFast, getJobsByDate, getTimelineRoutes, timelineRoutesToJobs, jsonRpc, PROXY_DRIVER_ID, type Env } from "./cartrack";
import { sendZaloMessage } from "./zalo";
import { PSC_TINH_LABEL } from "./psc-config";
import { DIAG_LOCATION_CUSTOMER_IDS } from "./psc-routes-data";
import { detectAndCreateReturnTrips, PSC_RETURN_LABEL, PSC_OUTBOUND_LABEL } from "./return-trips";
import { detectAndCreateViaLegs, PSC_VIA_LABEL } from "./via-legs";
import { cleanupStaleTrips } from "./cleanup-trips";
import { setHeldJobs, setFailedJobs, setPickupWarnings, setPscActivePickups, shouldRunProxySweep, shouldRunDailyRollover, type HeldJob, type PscDupHit } from "./smart-log-kv";
import { isValidDriverId } from "./config";
import {
  vnDate,
  vnTimestamp,
  vnHoursMinutes,
  vnMinutesSinceMidnight,
  vnDayWindow,
  parseVnTimestamp,
} from "./time";
import { haversineKm } from "./distance";
import { roadDistancesToPoint } from "./distance-cache";
import { isActiveStop, isCompletedOrRejectedStop, isNoteApproved, pscPairKey } from "./job-filters";
import { selectReferenceStop, computeStopStats, rankingComparator, ROUTE_STATE_PRIORITY, idleBand, type RefStop, type RefLabel } from "./smart-rank";
import { loadLeaveEntries, isDriverOnLeave, resolveSubstitute } from "./leave-config";


const DUPLICATE_REJECT_REASON =
  "Yêu cầu liền kề vẫn đang được thực hiện, quý khách vui lòng đợi thêm giây lát hoặc liên hệ Diag nếu cần được hỗ trợ!";

// Jobs carrying any of these labels are exempt from duplicate detection.
// PSC tỉnh jobs are multi-leg provincial routes — the same pickup→dropoff pair
// is expected to repeat across different legs and should never be blocked.
const DUPLICATE_EXEMPT_LABELS = [PSC_TINH_LABEL, PSC_RETURN_LABEL];

/**
 * Compact "HH:MM" for a Cartrack timestamp. The value is already VN-local in
 * both forms we see — REST has no offset ("2026-06-20 08:31:47"); the JSON-RPC
 * timeline carries a "+07" suffix and fractional seconds
 * ("2026-06-20 07:02:37.91659+07") — so we slice HH:MM straight out instead of
 * Date-parsing. (parseVnTimestamp appends a second "+07:00" onto the timeline
 * form → NaN, which is why this tag silently never rendered.)
 */
function hhmmVn(ts: string | null): string | null {
  if (!ts) return null;
  const m = /[ T](\d{2}):(\d{2})/.exec(ts);
  return m ? `${m[1]}:${m[2]}` : null;
}

/**
 * Verb shown beside a reference stop's tiebreak time in the smart log, so the
 * started-earliest tiebreak — and what the timestamp means per label — is
 * visible. En Route → "started HH:MM" is the value that decides same-GPS-bin ties;
 * the rest annotate where the tiebreakTs comes from (see selectReferenceStop).
 */
const TIEBREAK_VERB: Record<RefLabel, string> = {
  "Arrived": "arrived",
  "En Route": "started",
  "Next Stop": "left",
  "Available": "free",
  "First Stop": "shift",
  "Start Location": "shift",
};

/**
 * Build the PSC active-pickup dedup index from today's status-2/4 jobs. Each entry
 * keys a `pickup|dropoff` customer pair (a job with an active pickup stop + a
 * matching dropoff stop) to the blocking job, mirroring the exact predicate
 * /api/psc-assign used to evaluate live: cancelled (7) / failed (3) jobs and
 * via-legs are excluded, and only pickup stops that are still active (Created /
 * En Route / Arrived) count. Writing this once per cycle lets the PSC request
 * button skip two fleet-wide Cartrack fetches on every tap.
 */
function computeActivePickupPairs(jobs: Job[]): Record<string, PscDupHit> {
  const pairs: Record<string, PscDupHit> = {};
  for (const job of jobs) {
    if (job.job_status_id === 7 || job.job_status_id === 3) continue;
    if ((job.labels ?? []).includes(PSC_VIA_LABEL)) continue;
    const stops = job.stops ?? [];
    const activePickups = stops.filter(
      (s) => s.stop_type_id === 1 && s.customer_id && s.stop_status_id != null && isActiveStop(s.stop_status_id),
    );
    if (activePickups.length === 0) continue;
    const dropoffs = stops.filter((s) => s.stop_type_id === 2 && s.customer_id);
    const hit: PscDupHit = { job_id: job.job_id, reference_number: job.reference_number ?? null };
    for (const p of activePickups) {
      for (const d of dropoffs) {
        // First writer wins is fine — any one blocking job is enough to dedup, and
        // the live check it replaces also returned the first match.
        const key = pscPairKey(p.customer_id!, d.customer_id!);
        if (!(key in pairs)) pairs[key] = hit;
      }
    }
  }
  return pairs;
}

// ── Start-location coords cache ─────────────────────────────────────────────
// A driver's home base is static config; refetching it from Cartrack every
// cycle is thousands of identical calls/day. Positive results only (a transient
// fetch hiccup must not pin a driver as "no coords" for a day). 24h TTL; the
// dashboard Refresh (GET /api/config) busts it alongside the sheet caches.
const START_LOC_TTL_MS = 24 * 60 * 60 * 1000;
const startLocCache = new Map<
  string,
  { coords: { lat: number; lon: number; name: string | null }; fetchedAt: number }
>();

export function invalidateStartLocCache(): void {
  startLocCache.clear();
}

// ── Duplicate-check helpers ────────────────────────────────────────────────


// Returns Map<"pickup_id:dropoff_id", blocking_job_id> for assigned jobs today
// where the pickup stop is not yet completed/rejected and window is not >1h away.
function buildActiveRouteMap(jobs: any[]): Map<string, number> {
  const result = new Map<string, number>();

  // Current VN time in minutes-since-midnight
  const nowMinutes = vnMinutesSinceMidnight();

  // A job parked on the reject proxy is being rejected (by /sales cancel or by
  // our own duplicate path) — it's on its way out, so it must not block, nor
  // cause the rejection of, its twin. Otherwise an operator cancelling one of
  // two duplicates briefly turns it into a status-4 "active route owner" and the
  // cycle wrongly rejects the legitimate twin too.
  const rejectProxyId = process.env.CARTRACK_REJECT_PROXY_DRIVER_ID ?? "";

  for (const job of jobs) {
    if (job.job_status_id === 7 || job.job_status_id === 3) continue;
    if (rejectProxyId && job.delivery_driver_id === rejectProxyId) continue;
    // Via-legs are supplementary pickups (intentional double-coverage) — they must not
    // block a location's own request, so keep them out of the active-route map.
    if ((job.labels ?? []).includes(PSC_VIA_LABEL)) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stops = (job.stops ?? []) as any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickup  = stops.find((s: any) => s.stop_type_id === 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dropoff = stops.find((s: any) => s.stop_type_id === 2);
    if (!pickup?.customer_id || !dropoff?.customer_id) continue;
    if (isCompletedOrRejectedStop(pickup.stop_status_id ?? 0)) continue;

    // If pickup window starts >1h from now, don't block — allow a new immediate request
    // time_from is time-only e.g. "08:30:00+07:00"
    const timeFrom: string | undefined = pickup.delivery_windows?.[0]?.time_from;
    if (timeFrom) {
      const m = timeFrom.match(/^(\d{2}):(\d{2})/);
      if (m) {
        const windowMinutes = parseInt(m[1]) * 60 + parseInt(m[2]);
        let diff = windowMinutes - nowMinutes;
        if (diff < 0) diff += 24 * 60; // handle overnight window
        if (diff > 60) continue;
      }
    }

    result.set(`${pickup.customer_id}:${dropoff.customer_id}`, job.job_id);
  }
  return result;
}


/**
 * True if the job is released from a recurring Cartrack route plan. Such jobs
 * carry a `last_assigned_plan_id` (and a populated `plans` array); their
 * scheduled_delivery_ts is a fixed daily plan slot (e.g. 05:00 PSC→3PL legs,
 * recurring provincial pickups), not an ad-hoc ASAP request. The plan
 * regenerates a fresh copy each day, so a plan job must never be rolled to the
 * next day — that would duplicate it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasPlanAttached(job: any): boolean {
  return job.last_assigned_plan_id != null || (Array.isArray(job.plans) && job.plans.length > 0);
}

/**
 * True for jobs the engine treats as internal transport or plan-generated work
 * rather than an ad-hoc client request:
 *   - released from a recurring Cartrack route plan (see hasPlanAttached);
 *   - carrying an engine leg label (outbound / via / return) — timing dictated
 *     by the multi-leg route;
 *   - picking up AT a Diag location — internal transport (bag or consumable
 *     run, e.g. manually-created "Vận chuyển túi" jobs with no engine label)
 *     and PSC tỉnh legs, never a client sample request.
 * Used by the late-pickup warning.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isInternalOrPlanJob(job: any): boolean {
  if (hasPlanAttached(job)) return true;
  const labels: string[] = job.labels ?? [];
  if (
    labels.includes(PSC_OUTBOUND_LABEL) ||
    labels.includes(PSC_VIA_LABEL) ||
    labels.includes(PSC_RETURN_LABEL)
  ) return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pickup = ((job.stops ?? []) as any[]).find((s: any) => s.stop_type_id === 1);
  return !!(pickup?.customer_id && DIAG_LOCATION_CUSTOMER_IDS.has(pickup.customer_id));
}


function computePickupWarnings(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assignedJobs: any[],
  today: string,
): PickupWarning[] {
  const now = Date.now();
  const THIRTY_MIN_MS  = 30 * 60 * 1000;
  const FIFTEEN_MIN_MS = 15 * 60 * 1000;
  // Overdue grace for non-windowed (ASAP) pickups, measured from scheduled_delivery_ts.
  const OVERDUE_MIN = 30;
  const OVERDUE_MS  = OVERDUE_MIN * 60 * 1000;

  // Build per-driver lookup tables from all assigned jobs:
  //   inProgressStopIds — stops currently started but not completed
  //   lastCompletedMs   — epoch ms of the most recent completed stop
  const driverInProgressStopIds = new Map<string, Set<number>>();
  const driverLastCompletedMs   = new Map<string, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const job of assignedJobs) {
    const driverId: string | null = job.delivery_driver_id;
    if (!driverId) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const s of (job.stops ?? []) as any[]) {
      if (s.activity_started_ts && !s.activity_completed_ts) {
        if (!driverInProgressStopIds.has(driverId)) {
          driverInProgressStopIds.set(driverId, new Set());
        }
        driverInProgressStopIds.get(driverId)!.add(s.stop_id);
      }
      if (s.activity_completed_ts) {
        const t = parseSendToDriverAt(s.activity_completed_ts);
        if (t) {
          const prev = driverLastCompletedMs.get(driverId) ?? 0;
          if (t.getTime() > prev) driverLastCompletedMs.set(driverId, t.getTime());
        }
      }
    }
  }

  const warnings: PickupWarning[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const job of assignedJobs) {
    const driverId: string | null = job.delivery_driver_id;
    if (!driverId) continue;
    // Guard: skip jobs that are no longer active (cancelled/failed/deleted)
    if (job.job_status_id !== 4) continue;

    // Plan-released jobs, engine legs (outbound/via/return) and Diag-location
    // pickups aren't customer ASAP requests, so the 30-min overdue clock
    // doesn't apply — see isInternalOrPlanJob for the full rationale.
    if (isInternalOrPlanJob(job)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stops = (job.stops ?? []) as any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickup  = stops.find((s: any) => s.stop_type_id === 1);
    if (!pickup) continue;

    if (pickup.activity_started_ts) continue;
    // Guard: skip if stop is already completed or rejected
    if (isCompletedOrRejectedStop(pickup.stop_status_id ?? 0)) continue;

    const hasWindow =
      Array.isArray(pickup.delivery_windows) && pickup.delivery_windows.length > 0;

    let reason: PickupWarning["reason"] | null = null;
    let extra: Partial<PickupWarning> = {};

    if (!hasWindow) {
      // Case 1: no window (ASAP pickup) — warn if it has been waiting 30+ min and the
      // pickup still hasn't started. Anchored on scheduled_delivery_ts, NOT
      // send_to_driver_at: the latter is null for directly-assigned jobs (so they could
      // never warn) and Cartrack re-stamps it on every reassignment (so a bounced job's
      // clock kept resetting and hid hours of delay — e.g. jobs 34335798 / 34335650).
      // scheduled_delivery_ts is always present here (it's the getJobsByStatusAndDate
      // filter, ≈ create time for ASAP jobs) and is stable across reassignment.
      const anchor = parseVnTimestamp(job.scheduled_delivery_ts);
      if (isNaN(anchor.getTime())) continue;
      const elapsed = now - anchor.getTime();
      if (elapsed >= OVERDUE_MS) {
        reason = "overdue";
        extra = { minutes_late: Math.floor(elapsed / 60000) - OVERDUE_MIN };
      }
    } else {
      // Case 2 (delivery window): stashed — not active yet
      continue;
    }

    if (!reason) continue;

    // Skip if driver is actively working on another stop right now.
    const inProgressIds = driverInProgressStopIds.get(driverId);
    const busyElsewhere =
      inProgressIds && [...inProgressIds].some((id) => id !== pickup.stop_id);
    if (busyElsewhere) continue;

    // Skip if driver completed any stop within the last 30 min — they may
    // still be in transit to this pickup after finishing their previous job.
    const lastCompleted = driverLastCompletedMs.get(driverId) ?? 0;
    if (lastCompleted && now - lastCompleted < THIRTY_MIN_MS) continue;

    // Driver name straight off the job's embedded `driver` object — Cartrack returns
    // it fully populated on every assigned job (incl. offline / no-GPS drivers), so no
    // driver-list fetch is needed to resolve the name here.
    const driver = job.driver;
    const driverName = driver
      ? `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim() || null
      : null;

    const dropoff = stops.find((s: any) => s.stop_type_id === 2);

    warnings.push({
      job_id: job.job_id,
      reference_number: job.reference_number ?? null,
      pickup_customer_name: pickup.customer_name ?? null,
      dropoff_customer_name: dropoff?.customer_name ?? null,
      driver_id: driverId,
      driver_name: driverName,
      reason,
      ...extra,
    });
  }

  return warnings;
}

async function rejectJobAsDuplicate(jobId: number, env: Env): Promise<boolean> {
  const out = await jsonRpc(
    "delivery_reject_job",
    { data: { jobIds: [jobId], rejectReason: DUPLICATE_REJECT_REASON } },
    { env }
  );
  return out.ok;
}

// ── Smart-assign helpers ───────────────────────────────────────────────────

type DriverRouteInfo = { ref: RefStop | null; label: RefLabel | null; workload: number; lastCompletedTs: string | null; jobsDone: number };

// HCMC urban average-speed proxy for turning a straight-line haversine distance
// into an estimated travel time (minutes). Used ONLY as the SMART_RANK_BY_DURATION
// fallback when Goong returns no eta for a point, so the sort never mixes km with
// mins. ~20 km/h ⇒ 3 min/km.
const STRAIGHT_KM_TO_MIN = 3;

// Pure reducer: timeline routes → per-driver smart-rank info. Shared by the cycle
// (which, under ASSIGN_USE_TIMELINE, already fetched these routes for s4/s5) and by
// fetchSmartRouteData's standalone fetch — so the route data is derived from the
// SAME delivery_timeline_route_list payload instead of a second identical call.
function timelineRoutesToDriverInfo(
  routes: TimelineRoute[],
  shiftStartByDriverId: Record<string, string | null>
): Record<string, DriverRouteInfo> {
  const result: Record<string, DriverRouteInfo> = {};
  for (const route of routes) {
    const driverId = route.routeId.replace(/^driver_/, "");
    const stops = route.orderedStops ?? [];
    const refStop = selectReferenceStop(stops, shiftStartByDriverId[driverId] ?? null);
    const stats = computeStopStats(stops);
    result[driverId] = {
      ref: refStop,
      label: refStop?.label ?? null,
      workload: stops.length,
      lastCompletedTs: stats.lastCompletedTs,
      jobsDone: stats.done,
    };
  }
  return result;
}

// Client-coordinate index harvested from the timeline payload. Each stop carries
// customerId + latitude/longitude, so the routes we already fetch (Change 1) double
// as a fixed-client GPS source — saving a getCustomerById HTTP call per client whose
// location appears as a stop today (e.g. the hub PSCs that double as start-locations).
function timelineRoutesToCustomerCoords(
  routes: TimelineRoute[]
): Map<string, { lat: number; lon: number; name: string | null }> {
  const index = new Map<string, { lat: number; lon: number; name: string | null }>();
  for (const route of routes) {
    for (const s of route.orderedStops ?? []) {
      if (!s.customerId || s.latitude == null || s.longitude == null) continue;
      if (index.has(s.customerId)) continue;
      index.set(s.customerId, { lat: s.latitude, lon: s.longitude, name: s.customerName ?? null });
    }
  }
  return index;
}

async function fetchSmartRouteData(
  dateVn: string, env: Env,
  shiftStartByDriverId: Record<string, string | null>
): Promise<Record<string, DriverRouteInfo>> {
  const out = await jsonRpc<{ routes?: TimelineRoute[] }>(
    "delivery_timeline_route_list",
    { data: { scheduleType: "scheduled", filter: vnDayWindow(dateVn) } },
    { env }
  );
  if (!out.ok) return {};
  return timelineRoutesToDriverInfo(out.result?.routes ?? [], shiftStartByDriverId);
}

function makeLog(msg: string, level: LogLevel = "INFO"): LogEntry {
  return { ts: vnTimestamp(), level, msg };
}

/** True when Cartrack's 422 means the driver is on-break or offline. */
function isDriverUnavailable(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const ct = (body as Record<string, unknown>).error as Record<string, unknown> | undefined;
  const msgs = (ct?.data as Record<string, unknown> | undefined)?.delivery_driver_id;
  return Array.isArray(msgs) && msgs.some(
    (m: unknown) => typeof m === "string" && m.includes("does not exist or the current status")
  );
}


/**
 * Turn a Cartrack error response body into a short, readable reason instead of
 * dumping raw JSON into the log.
 * Cartrack wraps validation errors as { error: { message, data: { field: [msgs] } } }.
 */
function friendlyError(body: unknown, max = 180): string {
  let text: string;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    // Driver on-break / offline — most common assign failure, give a clear label.
    if (isDriverUnavailable(b)) return "Driver on-break or offline";
    // Cartrack's nested { error: { message, data: { field: [...] } } } structure.
    const ct = b.error as Record<string, unknown> | undefined;
    const ctData = ct?.data as Record<string, unknown> | undefined;
    if (ctData && typeof ctData === "object") {
      text = Object.entries(ctData)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("; ") : String(v)}`)
        .join(" | ");
    } else if (typeof ct?.message === "string" && ct.message.trim()) {
      text = ct.message.trim();
    } else if (typeof b.message === "string" && b.message.trim()) {
      text = b.message.trim();
    } else if (b.errors && typeof b.errors === "object") {
      text = Object.entries(b.errors as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("; ") : String(v)}`)
        .join(" | ");
    } else {
      text = JSON.stringify(b);
    }
  } else {
    text = String(body);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function timeToMinutes(t: { hours: number; minutes: number }): number {
  return t.hours * 60 + t.minutes;
}

export function isDriverOnShift(
  mapping: Mapping,
  jobTime: Date
): boolean {
  const { shift_start, shift_end } = mapping;
  if (!shift_start || !shift_end) return true; // no shift = always on

  const { hours, minutes } = vnHoursMinutes(jobTime);
  const jobMinutes = hours * 60 + minutes;
  const startMin = timeToMinutes(shift_start);
  const endMin = timeToMinutes(shift_end);

  // Overnight shift (e.g. 22:00 - 06:00)
  // shift_start is exclusive: outgoing driver owns the boundary minute
  if (startMin > endMin) {
    return jobMinutes > startMin || jobMinutes <= endMin;
  }
  return jobMinutes > startMin && jobMinutes <= endMin;
}

export function getDriversOnDuty(
  config: Config,
  customerId: string,
  jobTime: Date
): [Mapping[], "no_mapping" | "no_driver" | "happy" | "clash"] {
  const customerMappings = config.mappings.filter(
    (m) => m.customer_id === customerId
  );

  if (customerMappings.length === 0) return [[], "no_mapping"];

  const onDuty = customerMappings.filter((m) =>
    isDriverOnShift(m, jobTime)
  );

  if (onDuty.length === 0) return [customerMappings, "no_driver"];
  if (onDuty.length === 1) return [onDuty, "happy"];
  return [onDuty, "clash"];
}


export function jobHasNotes(job: Job): boolean {
  for (const stop of job.stops ?? []) {
    const note = stop.note;
    if (note && note.trim() && note.trim() !== "Call before delivery") {
      return true;
    }
  }
  return false;
}

/** All meaningful stop notes on a job, joined — for showing why it was skipped. */
export function getJobNoteText(job: Job): string {
  const notes: string[] = [];
  for (const stop of job.stops ?? []) {
    const note = stop.note;
    if (note && note.trim() && note.trim() !== "Call before delivery") {
      notes.push(note.trim());
    }
  }
  return notes.join(" | ");
}

export function getCustomerIdFromJob(job: Job): string | null {
  for (const stop of job.stops ?? []) {
    if (stop.stop_type_id === 1) return stop.customer_id ?? null;
  }
  return null;
}

export function getCustomerNameFromJob(job: Job): string | null {
  for (const stop of job.stops ?? []) {
    if (stop.stop_type_id === 1) {
      return stop.customer_name || stop.name || stop.address || null;
    }
  }
  return null;
}

/**
 * Swap the dropoff customer on a job when alt_drop_off_id is configured.
 * Returns true if the swap succeeded (or wasn't needed), false if it failed
 * and the job should be skipped.
 */
type AltDropoffResult = {
  ok: boolean;
  dropoffName?: string;
  dropoffLat?: number | null;
  dropoffLon?: number | null;
};

/**
 * Swap a job's dropoff to `altDropOffId` before assigning. Takes the in-hand
 * `jobStops` (from the unassigned job) so it needs no getJobDetails, and returns
 * the new dropoff's name + coords (from the alt customer record it already fetches)
 * so the caller can log/notify the swap without re-fetching either.
 */
async function applyAltDropoff(
  jobId: number,
  altDropOffId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jobStops: any[],
  env: Env,
  log: (msg: string, level?: LogLevel) => void
): Promise<AltDropoffResult> {
  let altCustomerName = altDropOffId;
  let altLat: number | null | undefined;
  let altLon: number | null | undefined;
  try {
    const customerData = await getCustomerById(altDropOffId, env);
    if (customerData?.data) {
      const c = customerData.data;
      altCustomerName = c.customer_name || c.name || altCustomerName;
      altLat = c.latitude;
      altLon = c.longitude;
    }

    const updatedStops = (jobStops ?? [])
      .filter((s) => s.stop_id && s.stop_type_id && s.customer_id)
      .map((s) => ({
        stop_id: s.stop_id,
        stop_type_id: s.stop_type_id,
        customer_id: s.stop_type_id === 2 ? altDropOffId : s.customer_id,
        ...(s.stop_type_id === 2 ? { customer_name: altCustomerName } : {}),
      }));

    if (updatedStops.length >= 2) {
      const putRes = await updateJobStops(jobId, updatedStops, env);
      if (putRes.ok) {
        log(`Job ${jobId} - dropoff swapped to ${altCustomerName}`, "INFO");
      } else {
        log(`Job ${jobId} - dropoff swap failed (${putRes.status})`, "ERROR");
        return { ok: false };
      }
    }
    return { ok: true, dropoffName: altCustomerName, dropoffLat: altLat, dropoffLon: altLon };
  } catch (e) {
    log(`Job ${jobId} - dropoff swap error: ${e}`, "ERROR");
    return { ok: false };
  }
}

export function buildGmapsRouteLink(
  lat1?: number | null,
  lng1?: number | null,
  lat2?: number | null,
  lng2?: number | null
): string | null {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null)
    return null;

  const saddr = encodeURIComponent("Current Location");
  return (
    `https://maps.google.com/maps?` +
    `directionsmode=motorbike` +
    `&saddr=${saddr}` +
    `&daddr=${lat1},${lng1}+to:${lat2},${lng2}`
  );
}

/** Parse "YYYY-MM-DD HH:MM:SS+07" or "YYYY-MM-DD HH:MM:SS+07:00" to Date. */
function parseSendToDriverAt(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const normalized = ts.trim().replace(" ", "T").replace(/\+(\d{2})$/, "+$1:00");
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d;
}

/** Parse pickup delivery_window time_from ("H:i:sP") to a full Date for dateVn. */
function parsePickupWindowTime(timeStr: string, dateVn: string): Date | null {
  const m = timeStr.match(/^(\d{1,2}):(\d{2}):\d{2}([+-]\d{2}:?\d{2})$/);
  if (!m) return null;
  const tz = m[3].includes(":") ? m[3] : m[3].replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  return new Date(`${dateVn}T${m[1].padStart(2, "0")}:${m[2]}:00${tz}`);
}

/**
 * Release parked jobs from the proxy driver whose send_to_driver_at has passed.
 * Sets each job back to unassigned so the assign cycle picks it up.
 *
 * `proxyJobs` (optional) is a pre-sourced parked-job list — in timeline mode the
 * cycle passes the proxy driver's jobs from the timeline payload it already
 * fetched, skipping the per-cycle REST list. When omitted, fetches the full
 * no-date-filter REST list (non-timeline path and the periodic stranded-job
 * sweep — the date-windowed timeline can't see a job whose scheduled day has
 * passed, e.g. a release missed during an outage).
 */
async function releaseDueProxyJobs(
  dateVn: string,
  env: Env,
  log: (msg: string, level?: LogLevel) => void,
  proxyJobs?: Job[],
): Promise<{ listMs: number; releaseMs: number; releasedIds: number[] }> {
  const _t0 = Date.now();
  const parked = proxyJobs ?? await getAllAssignedDriverJobs(PROXY_DRIVER_ID, env);
  const listMs = Date.now() - _t0;
  const now = Date.now();
  const due = parked.filter((job) => {
    const sendAt = parseSendToDriverAt(job.send_to_driver_at);
    return sendAt !== null && sendAt.getTime() <= now;
  });
  // Release concurrently (bounded 10) — each unassign is independent.
  const _t1 = Date.now();
  const releasedIds: number[] = [];
  for (let i = 0; i < due.length; i += 10) {
    await Promise.all(due.slice(i, i + 10).map(async (job) => {
      const { ok, status } = await unassignJob(job.job_id, env, PROXY_DRIVER_ID);
      const relRoute = `${job.stops?.find((s) => s.stop_type_id === 1)?.customer_name ?? "—"} → ${job.stops?.find((s) => s.stop_type_id === 2)?.customer_name ?? "—"}`;
      if (ok) {
        releasedIds.push(job.job_id);
        log(`Job ${job.job_id} - RELEASED from proxy driver (was parked until ${job.send_to_driver_at}) | ${relRoute}`, "INFO");
      } else {
        log(`Job ${job.job_id} - Release failed (HTTP ${status}) | ${relRoute}`, "WARN");
      }
    }));
  }
  return { listMs, releaseMs: Date.now() - _t1, releasedIds };
}

/**
 * Reclaim yesterday's unfinished ad-hoc jobs into `toDate` (today) so the
 * morning cycle assigns them. The cycle fetches by scheduled_delivery_ts =
 * today, so a job left over from yesterday is otherwise invisible — never
 * assigned, never surfaced in "Cần xử lý" (the snapshot only holds jobs the
 * cycle saw).
 *
 * `candidates` is yesterday's status 2 (unassigned) + status 4 (assigned,
 * possibly started) — the fetch already excludes completed (5) and cancelled
 * (7), so everything here is genuinely unfinished. Two eligibility rules:
 *   1. NO plan attached (hasPlanAttached). Recurring plan slots regenerate
 *      themselves each day, so rolling one would duplicate it.
 *   2. Pickup NOT yet collected (pickup stop_status_id !== 4). Reassignment
 *      resets stop activity, so a job whose sample is already picked up would
 *      be re-collected — a wasted second pickup.
 * Everything else — engine legs, en-route/arrived jobs, jobs with a stale
 * driver — rolls.
 *
 * For each eligible job:
 *   - if a driver is still attached (status-4 stuck/started job), unassign it
 *     first so it re-enters the pool. Cartrack keeps the stop activity
 *     timestamps; if it refuses the unassign (e.g. a job genuinely in flight)
 *     we log and skip rather than fail the pass;
 *   - re-date scheduled_delivery_ts to today. The cycle's own fetch, which runs
 *     right after this pass, then finds it as today's status-2 and assigns it.
 * Runs before the fetch, so bumped jobs are picked up the same cycle.
 */
async function rolloverUnfinishedJobs(
  candidates: Job[],
  toDate: string,
  env: Env,
  log: (msg: string, level?: LogLevel) => void,
): Promise<Set<number>> {
  const eligible = candidates.filter((j) => {
    if (hasPlanAttached(j)) return false;                 // plan slot → regenerates itself; never roll
    const stops = j.stops ?? [];
    // Skip if the pickup sample is already collected. Re-assignment resets a
    // stop's activity, so rolling a job whose pickup is Hoàn thành (status 4)
    // would send the new driver to collect the same sample again. Pickup still
    // Chờ lấy / Đang đến / Đã đến (1/2/3) = not yet taken → safe to roll.
    const pickup = stops.find((s) => s.stop_type_id === 1);
    if (pickup?.stop_status_id === 4) return false;
    // Belt-and-braces: skip a job whose every stop is already terminal (a
    // fully-done job lagging at status 4/5). Nothing to reassign.
    if (stops.length > 0 && stops.every((s) => isCompletedOrRejectedStop(s.stop_status_id ?? 0))) return false;
    return true;
  });
  const bumped = new Set<number>();
  for (const job of eligible) {
    const route = `${job.stops?.find((s) => s.stop_type_id === 1)?.customer_name ?? "—"} → ${
      job.stops?.find((s) => s.stop_type_id === 2)?.customer_name ?? "—"
    }`;
    // Pull the stale driver first so the job re-enters the unassigned pool.
    if (job.delivery_driver_id) {
      const { ok, status } = await unassignJob(job.job_id, env, job.delivery_driver_id);
      if (!ok) {
        log(`Job ${job.job_id} - Rollover unassign failed (HTTP ${status}) | ${route}`, "WARN");
        continue;
      }
    }
    const { ok, status } = await updateJobScheduledDeliveryTs(job.job_id, `${toDate} 00:00:00`, env);
    if (ok) {
      bumped.add(job.job_id);
      log(`Job ${job.job_id} - ROLLED OVER to ${toDate} (chưa xử lý xong hôm qua) | ${route}`, "INFO");
    } else {
      log(`Job ${job.job_id} - Rollover to ${toDate} failed (HTTP ${status}) | ${route}`, "WARN");
    }
  }
  return bumped;
}

export async function autoAssignCycle(
  config: Config,
  env: Env = "prod",
  skipSmart = false,
  // Targeted manual assign: process only these job(s) and bypass their note
  // gate. Used by the "assign anyway" action on note-held jobs.
  onlyJobIds?: Set<number>,
): Promise<LogEntry[]> {
  const logs: LogEntry[] = [];
  const log = (msg: string, level: LogLevel = "INFO") => {
    logs.push(makeLog(msg, level));
  };

  // ── G1: timing instrumentation. clog() streams to Vercel runtime logs immediately,
  // so on a 60s kill the LAST "[timing]" line before the timeout error pinpoints the slow
  // phase (the normal log()/run_log is lost on a kill). It prefixes each line with VN
  // wall-clock time because Vercel's own log prefix is UTC (= VN−7h), which is confusing.
  const tStart = Date.now();
  let tMark = tStart;
  const clog = (m: string) => console.log(`[VN ${vnTimestamp()}] ${m}`);
  const phase = (name: string) => {
    const now = Date.now();
    clog(`[timing] ${name}: +${now - tMark}ms (total ${now - tStart}ms)`);
    tMark = now;
  };
  let goongMs = 0;
  let altMs = 0, zaloMs = 0, optimizeMs = 0;
  let _jobIdx = 0;
  const driversToOptimize = new Set<string>();

  // One Cartrack call per cycle: getJobsByDate fetches ALL of today's jobs and we
  // partition into status 2/4/5 in memory (a trivial O(n) pass), instead of three
  // separate status-filtered fetches. These three lists are shared with the
  // follow-up steps in `finally`, so nothing is re-downloaded. null = the single
  // fetch FAILED → the follow-ups self-fetch per status, because trusting a
  // silently-empty list would let return-trip dedup create duplicate trips.
  let cycleStartS2: Job[] | null = null;
  let assignedJobsToday: Job[] | null = null;
  let cycleS5: Job[] | null = null;
  // Timeline routes fetched in the fetch phase (ASSIGN_USE_TIMELINE) — stashed so
  // smart-prep can derive its per-driver route data from the same payload instead
  // of making a second identical delivery_timeline_route_list call.
  let timelineRoutesForSmart: TimelineRoute[] | null = null;

  try {
  // ── Release parked proxy jobs whose send_to_driver_at has passed ──────────
  // Skipped on a targeted manual assign — that's not a full cycle.
  const today = vnDate();
  const leaveEntries = await loadLeaveEntries().catch((e) => {
    log(`⚠️  Leave sheet failed to load: ${String(e).slice(0, 80)}`, "WARN");
    return [];
  });
  if (leaveEntries.length === 0) {
    const hh = new Date().getHours();
    if (hh >= 6 && hh < 22) {
      log("⚠️  No leave entries loaded (empty array) — all drivers will be treated as available", "WARN");
    }
  }
  // Timeline mode defers the proxy release to the fetch phase — the parked jobs
  // ride the timeline payload the cycle fetches anyway, so no per-cycle REST
  // list is needed. Non-timeline mode keeps release-before-fetch so released
  // jobs surface as status 2 in the same getJobsByDate call.
  const useTimeline = process.env.ASSIGN_USE_TIMELINE === "1";
  const _tLeave = Date.now();
  const _proxyTiming = onlyJobIds || useTimeline ? null : await releaseDueProxyJobs(today, env, log);
  const _proxyStr = _proxyTiming
    ? ` | proxy-list: ${_proxyTiming.listMs}ms + release: ${_proxyTiming.releaseMs}ms`
    : onlyJobIds ? " | proxy-release: skipped (targeted)" : " | proxy-release: deferred (timeline)";
  clog(`[setup] leave-sheet: ${_tLeave - tStart}ms${_proxyStr}`);
  phase("setup+proxy-release");

  // ── Morning rollover: yesterday's unfinished client jobs → today ──────────
  // Once per day (Redis NX gate; without Redis every cycle retries — harmless,
  // after the first pass yesterday's window is empty). Runs BEFORE the fetch so
  // bumped jobs surface as today's status 2 in this same cycle. Pulls BOTH
  // yesterday's unassigned (status 2) and its still-assigned-but-unfinished
  // jobs (status 4 — stale/started jobs whose driver never delivered);
  // rolloverUnfinishedJobs unassigns the latter and re-dates both to today.
  if (!onlyJobIds && (await shouldRunDailyRollover(today, env))) {
    try {
      const yesterday = vnDate(new Date(Date.now() - 86_400_000));
      const [ys2, ys4] = await Promise.all([
        getJobsByStatusAndDate(2, yesterday, env),
        getJobsByStatusAndDate(4, yesterday, env),
      ]);
      await rolloverUnfinishedJobs([...ys2, ...ys4], today, env, log);
    } catch (e) {
      log(`Morning rollover failed: ${e}`, "WARN");
    }
    phase("morning-rollover");
  }

  // Fetch ALL of today's jobs in one call (scheduled_delivery_ts = today), then
  // partition by status. scheduled_delivery_ts (not create_ts) means multi-day
  // parked jobs released from the proxy driver are found on their scheduled day.
  // Done AFTER releaseDueProxyJobs so jobs it just released show up as status 2.
  let s2Jobs: Job[] = [];
  let fetchMs = 0, partitionMs = 0;
  try {
    let done = false;
    // ASSIGN_USE_TIMELINE=1: s2 (unassigned) from REST; s4+s5 from the route-timeline
    // — one fast ~2.3s JSON-RPC call vs the variable 6-21s getJobsByDate. Falls back
    // to getJobsByDate below if the timeline call fails (cookie/login/shape), so dedup
    // and follow-ups never go blind. Default (unset) = the getJobsByDate path.
    if (useTimeline) {
      // s2 has no timeline (driverless jobs are on nobody's route). Fast path:
      // list_new + get_job_details (~0.4s, CREATE_JOB_RPC=1); null → the ~5-10s
      // REST status-2 list, which stays the authoritative fallback.
      let s2Src = "rest";
      const fetchS2 = async (): Promise<Job[]> => {
        if (process.env.CREATE_JOB_RPC === "1") {
          const fast = await getUnassignedJobsFast(today, env);
          if (fast) { s2Src = "rpc"; return fast; }
        }
        return getJobsByStatusAndDate(2, today, env);
      };
      const _tFetch = Date.now();
      const [restS2, routes] = await Promise.all([
        fetchS2(),
        getTimelineRoutes(today, env),
      ]);
      fetchMs = Date.now() - _tFetch;
      const timelineJobs = routes ? timelineRoutesToJobs(routes) : null;
      if (timelineJobs) {
        const _tPart = Date.now();
        const s4Jobs: Job[] = []; const s5Jobs: Job[] = [];
        for (const j of timelineJobs) (j.job_status_id === 5 ? s5Jobs : s4Jobs).push(j);
        // Footgun #1: a status-2 job with a driver set is really assigned → s4 pot
        // (dedupe against timeline jobs so it isn't counted twice).
        const tlIds = new Set(timelineJobs.map((j) => j.job_id));
        for (const j of restS2) if (j.delivery_driver_id && !tlIds.has(j.job_id)) s4Jobs.push(j);
        s2Jobs = restS2.filter((j) => !j.delivery_driver_id);
        cycleStartS2 = s2Jobs;
        assignedJobsToday = s4Jobs;
        cycleS5 = s5Jobs;
        timelineRoutesForSmart = routes; // reuse in smart-prep (skip 2nd identical JSON-RPC)
        partitionMs = Date.now() - _tPart;
        clog(`[fetch] timeline: fetch ${fetchMs}ms + partition ${partitionMs}ms (s2:${s2Jobs.length} s4:${s4Jobs.length} s5:${s5Jobs.length} s2-src=${s2Src})`);
        // Proxy release, timeline-sourced: the proxy driver's parked jobs are
        // already in the s4 partition (it's a driver on the timeline), so the
        // old per-cycle REST list is skipped. Every ~30 min a full no-date REST
        // sweep runs instead — the safety net for jobs stranded from a previous
        // day, which today's timeline window can't show.
        if (!onlyJobIds) {
          const sweep = await shouldRunProxySweep();
          const rel = await releaseDueProxyJobs(
            today, env, log,
            sweep ? undefined : s4Jobs.filter((j) => j.delivery_driver_id === PROXY_DRIVER_ID),
          );
          clog(`[fetch] proxy-release (${sweep ? "REST sweep" : "timeline"}): list ${rel.listMs}ms + release ${rel.releaseMs}ms (${rel.releasedIds.length} released)`);
          if (rel.releasedIds.length > 0) {
            // Parity with the release-before-fetch REST path: released jobs must
            // assign THIS cycle and must leave the assigned pot. Re-fetch s2 for
            // the full REST Job shape (notes, delivery windows — the note gate
            // and window parking need fields the timeline shape lacks) and drop
            // the released ids from s4.
            const releasedSet = new Set(rel.releasedIds);
            assignedJobsToday = s4Jobs.filter((j) => !releasedSet.has(j.job_id));
            const freshS2 = await fetchS2();
            s2Jobs = freshS2.filter((j) => !j.delivery_driver_id);
            cycleStartS2 = s2Jobs;
          }
        }
        done = true;
      } else {
        clog(`[fetch] timeline failed (${fetchMs}ms), falling back to REST`);
      }
    }
    if (!done) {
      // Timeline mode deferred the proxy release; the timeline fetch failed, so
      // run it the old way (full REST list) before fetching — released jobs then
      // surface as status 2 in getJobsByDate below.
      if (useTimeline && !onlyJobIds) await releaseDueProxyJobs(today, env, log);
      const _tFetch = Date.now();
      const allToday = await getJobsByDate(today, env);
      fetchMs = Date.now() - _tFetch;
      const _tPart = Date.now();
      s2Jobs = []; const s4Jobs: Job[] = []; const s5Jobs: Job[] = [];
      for (const j of allToday) {
        // A job with a driver is ASSIGNED regardless of status (footgun #1, reverse):
        // a manual assignment can leave the list reporting status 2 while
        // delivery_driver_id is already set. Treating it as unassigned would re-flag
        // it (e.g. NO MAPPING) every cycle, so count it as assigned instead.
        const assigned = !!j.delivery_driver_id;
        if (j.job_status_id === 2 && !assigned) s2Jobs.push(j);
        else if (j.job_status_id === 4 || (j.job_status_id === 2 && assigned)) s4Jobs.push(j);
        else if (j.job_status_id === 5) s5Jobs.push(j);
      }
      partitionMs = Date.now() - _tPart;
      cycleStartS2 = s2Jobs;
      assignedJobsToday = s4Jobs;
      cycleS5 = s5Jobs;
      clog(`[fetch] REST: fetch ${fetchMs}ms + partition ${partitionMs}ms (s2:${s2Jobs.length} s4:${s4Jobs.length} s5:${s5Jobs.length})`);
    }

    // Refresh the PSC active-pickup dedup index (full cycle only). Fire-and-forget:
    // it feeds /api/psc-assign's fast path and must not add latency to the cycle.
    if (!onlyJobIds) void setPscActivePickups(computeActivePickupPairs([...(cycleStartS2 ?? []), ...(assignedJobsToday ?? [])]));
  } catch (e) {
    log(`Error fetching jobs: ${e}`, "ERROR");
    return logs;
  }
  phase("fetch+partition");

  // Targeted manual assign: narrow to just the requested job(s).
  let jobs: Job[] = onlyJobIds ? s2Jobs.filter((j) => onlyJobIds.has(j.job_id)) : s2Jobs;

  // Jobs held back this cycle because a stop has a note (full cycle only).
  const heldJobs: HeldJob[] = [];

  // Jobs this cycle couldn't assign for a deterministic, recurring reason. These
  // used to re-print the same ERROR every cycle and bury the live log; now they
  // ride a snapshot the dashboard "Cần xử lý" panel reads instead. The log() lines
  // stay for the per-cycle return (smart history / debug) but are dropped from the
  // rolling live log by shouldStore. One push per job — each fails at most once.
  const failedJobs: FailedJob[] = [];
  // `fail` is defined inside the per-job worker below so it closes over that job's
  // `route` — no shared mutable state, safe when jobs run concurrently.

  if (jobs.length === 0) {
    log("No unassigned jobs");
    if (!onlyJobIds) await Promise.all([setHeldJobs(heldJobs), setFailedJobs(failedJobs)]);
    return logs;
  }

  log(`Found ${jobs.length} unassigned job(s)`);

  // Assigned jobs (status 4) already came from the single getJobsByDate partition
  // above — reused here for duplicate-check + pickup warnings, and again in the
  // follow-up steps, with no extra Cartrack call.
  // ── Pre-fetch GPS + route data only if a current job needs smart-assign ──────
  const smartCustomerIds = new Set(
    config.mappings.filter((m) => m.smart_driver_id.length > 0).map((m) => m.customer_id)
  );
  const hasSmartJobs = !skipSmart && jobs.some((j) => {
    const cid = getCustomerIdFromJob(j);
    return cid !== null && smartCustomerIds.has(cid);
  });

  // Note: `allGpsDrivers` now also includes drivers without GPS if they have a start_location
  // (Phase 1 haversine falls back to start_location when GPS is unavailable).
  let allGpsDrivers: Driver[] = [];
  let smartRouteData: Record<string, DriverRouteInfo> = {};
  const phase1Coords = new Map<string, { lat: number; lon: number }>();

  if (hasSmartJobs) {
    const fetchedDrivers = await getDrivers(env);
    allGpsDrivers = fetchedDrivers.filter((d) =>
      (d.latitude != null && d.longitude != null) || !!d.start_location_customer_id
    );
    const shiftStartByDriverId: Record<string, string | null> = {};
    for (const d of allGpsDrivers) shiftStartByDriverId[d.delivery_driver_id] = d.shift_time_start ?? null;
    // Client-coordinate index from the timeline (Change 2) — fixed-client GPS for
    // every customer that appears as a stop today, harvested from the routes we
    // already have. Consulted before getCustomerById below. Empty when timeline
    // mode is off (no routes stashed), so that path stays unchanged.
    let clientCoords = new Map<string, { lat: number; lon: number; name: string | null }>();
    if (timelineRoutesForSmart) {
      // Reuse the routes the fetch phase already pulled (ASSIGN_USE_TIMELINE on) — same
      // delivery_timeline_route_list payload, so no second ~2.3s call this cycle.
      smartRouteData = timelineRoutesToDriverInfo(timelineRoutesForSmart, shiftStartByDriverId);
      clientCoords = timelineRoutesToCustomerCoords(timelineRoutesForSmart);
    } else {
      smartRouteData = await fetchSmartRouteData(vnDate(), env, shiftStartByDriverId);
    }

    // ── Fetch start_location coords for drivers who need them ──
    // Two reasons: (1) no GPS → Phase 1 fallback, (2) no route today → reference-stop fallback.
    const startLocIdsNeeded = new Set<string>();
    for (const d of allGpsDrivers) {
      if (!d.start_location_customer_id) continue;
      const info = smartRouteData[d.delivery_driver_id];
      const noGps = d.latitude == null || d.longitude == null;
      const needsRefFallback = !info?.ref;
      if (noGps || needsRefFallback) startLocIdsNeeded.add(d.start_location_customer_id);
    }
    const startLocCoords = new Map<string, { lat: number; lon: number; name: string | null }>();
    const nowMs = Date.now();
    const startLocToFetch: string[] = [];
    for (const cid of startLocIdsNeeded) {
      // Timeline-harvested coords first (free — already in memory), then the in-memory
      // TTL cache, then a getCustomerById fetch for whatever's left.
      const fromTimeline = clientCoords.get(cid);
      if (fromTimeline) { startLocCoords.set(cid, fromTimeline); continue; }
      const hit = startLocCache.get(`${env}:${cid}`);
      if (hit && nowMs - hit.fetchedAt < START_LOC_TTL_MS) startLocCoords.set(cid, hit.coords);
      else startLocToFetch.push(cid);
    }
    await Promise.all(
      startLocToFetch.map(async (cid) => {
        const customerData = await getCustomerById(cid, env);
        const c = customerData?.data;
        if (c?.latitude != null && c?.longitude != null) {
          const coords = { lat: c.latitude, lon: c.longitude, name: c.customer_name ?? null };
          startLocCoords.set(cid, coords);
          startLocCache.set(`${env}:${cid}`, { coords, fetchedAt: nowMs });
        }
      })
    );

    // Reference-stop fallback: drivers with no usable ref (no route, or all stops windowed) → use start_location
    for (const d of allGpsDrivers) {
      if (!d.start_location_customer_id) continue;
      const info = smartRouteData[d.delivery_driver_id];
      if (info?.ref) continue;
      const coords = startLocCoords.get(d.start_location_customer_id);
      if (!coords) continue;
      smartRouteData[d.delivery_driver_id] = {
        ref: {
          lat: coords.lat,
          lon: coords.lon,
          label: "Start Location",
          customerName: coords.name,
          tiebreakTs: d.shift_time_start ?? null,
        },
        label: "Start Location",
        workload: info?.workload ?? 0,
        lastCompletedTs: info?.lastCompletedTs ?? null,
        jobsDone: info?.jobsDone ?? 0,
      };
    }

    // Phase 1 effective coords: GPS if available, else start_location fallback
    for (const d of allGpsDrivers) {
      if (d.latitude != null && d.longitude != null) {
        phase1Coords.set(d.delivery_driver_id, { lat: d.latitude, lon: d.longitude });
      } else if (d.start_location_customer_id) {
        const coords = startLocCoords.get(d.start_location_customer_id);
        if (coords) phase1Coords.set(d.delivery_driver_id, { lat: coords.lat, lon: coords.lon });
      }
    }

    log(`Smart-assign ready: ${phase1Coords.size} candidate driver(s) (GPS or start_location)`);
  }
  phase("smart-prep");

  // Duplicate-check map from the status-4 partition obtained above. Reused for
  // pickup warnings and the follow-up steps too.
  const activeRouteMap = buildActiveRouteMap(assignedJobsToday ?? []);

  // Fold note-held jobs into the SAME map so an incoming twin can see them. They're
  // invisible otherwise: buildActiveRouteMap indexes only assigned (status-4) jobs,
  // and a held job `continue`s on the note gate below before it could register its
  // own route — the double blind spot that let 34342828's twin (34342832) auto-
  // assign. Held routes go in as NEGATIVE job ids: at the dedup check a positive hit
  // is an assigned job (reject the twin), a negative hit is a held job whose intent
  // is unconfirmed (e.g. "làm sau") → hold the twin instead. An existing assigned
  // entry wins (we only fill gaps); once the held job is itself assigned or parks to
  // a window, the route resolves through the normal positive path.
  for (const hj of jobs) {
    if (onlyJobIds?.has(hj.job_id)) continue;            // override-forced jobs aren't held
    if (!jobHasNotes(hj) || isNoteApproved(hj)) continue;
    if (hj.stops?.find((s) => s.stop_type_id === 1)?.delivery_windows?.[0]?.time_from) continue; // windowed → parked, not held
    const pid = getCustomerIdFromJob(hj);
    const did = hj.stops?.find((s) => s.stop_type_id === 2)?.customer_id ?? null;
    if (!pid || !did) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const labels: string[] = (hj as any).labels ?? [];
    if (labels.some((l) => DUPLICATE_EXEMPT_LABELS.includes(l))) continue;
    const key = `${pid}:${did}`;
    if (!activeRouteMap.has(key)) activeRouteMap.set(key, -hj.job_id);  // negative = held → skip, not reject
  }

  const processJob = async (job: Job): Promise<void> => {
    const jobId = job.job_id;
    clog(`[loop] job ${++_jobIdx}/${jobs.length} jobId=${jobId} (t=${Date.now() - tStart}ms)`);
    const customerId = getCustomerIdFromJob(job);
    const jobCustomerName = getCustomerNameFromJob(job);
    // Uniform log suffix: every job line ends " | <pickup> → <dropoff>", so the
    // customer is always the single trailing field. All other detail (driver,
    // shifts, reason, …) goes before the one " | ". See docs/log-templates.md.
    const route = `${jobCustomerName ?? customerId ?? "—"} → ${
      job.stops?.find((s) => s.stop_type_id === 2)?.customer_name ?? "—"
    }`;
    // Per-job failure recorder — closes over this job's `route` (no shared state).
    const fail = (
      reason: FailedJob["reason"],
      jobIdArg: number,
      customer: string,
      detail: string,
      level: "ERROR" | "WARN" = "ERROR",
    ) => {
      if (!onlyJobIds) failedJobs.push({ job_id: jobIdArg, customer: route || customer, reason, detail, level, ts: vnTimestamp() });
    };
    // Single-pass block: the body's many top-level `continue`s mean "skip this job"
    // (continue → while(false) → exit). The nested candidate-retry `for` loop's own
    // continue/break are unaffected — this avoids converting ~20 continue→return.
    do {

    if (jobHasNotes(job)) {
      // Jobs with a delivery window bypass the note gate — the window parking path
      // handles them. The note is driver context, not a blocker for scheduled jobs.
      const hasWindow = !!(job.stops?.find((s) => s.stop_type_id === 1)?.delivery_windows?.[0]?.time_from);
      // The supervisor-approved mark (stamped by "Giao ngay") also bypasses the
      // gate: the note stays as driver context, but the job assigns this cycle.
      const approved = isNoteApproved(job);
      if (!hasWindow) {
        if (!approved && !onlyJobIds?.has(jobId)) {
          log(`Job ${jobId} - SKIPPED (has note): "${getJobNoteText(job)}" | ${route}`);
          heldJobs.push({ job_id: jobId, customer: jobCustomerName ?? customerId ?? "—", note: getJobNoteText(job) });
          continue;
        }
        const why = approved ? "approved mark" : "manual override";
        log(`Job ${jobId} - ASSIGNING despite note (${why}): "${getJobNoteText(job)}" | ${route}`, "WARN");
      }
    }

    if (!customerId) {
      // Not a real issue (e.g. delivery-only jobs) — keep at INFO so it's not
      // surfaced as an error and is dropped from the stored log.
      log(`Job ${jobId} - No pickup stop found`, "INFO");
      continue;
    }

    // ── Duplicate check: assign to proxy driver then JSONRPC-reject ──────────
    const dropoffId = job.stops?.find((s) => s.stop_type_id === 2)?.customer_id ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobLabels: string[] = (job as any).labels ?? [];
    const isDuplicateExempt = jobLabels.some((l) => DUPLICATE_EXEMPT_LABELS.includes(l));
    const routeKey = dropoffId && !isDuplicateExempt ? `${customerId}:${dropoffId}` : null;
    const blockingJobId = routeKey ? activeRouteMap.get(routeKey) : undefined;
    if (blockingJobId != null && Math.abs(blockingJobId) !== jobId) {
      if (blockingJobId < 0) {
        // Negative = a note-held twin awaiting review owns this route. Hold this job
        // too (skip, don't reject) while that job's intent is unconfirmed. Self-
        // resolving: once the held job is assigned it flips positive here and the
        // reject path below applies; if it parks to a window it drops out of the map
        // and this job proceeds.
        log(`Job ${jobId} - SKIPPED: trùng tuyến với job ${-blockingJobId} đang chờ duyệt ghi chú | ${route}`, "WARN");
        continue;
      }
      const proxyDriverId = process.env.CARTRACK_REJECT_PROXY_DRIVER_ID ?? "";
      if (proxyDriverId) {
        const { status: assignStatus } = await assignJob(proxyDriverId, jobId, env);
        if (assignStatus === 200) {
          const ok = await rejectJobAsDuplicate(jobId, env);
          log(`Job ${jobId} - DUPLICATE of Job ${blockingJobId}: assigned then rejected ${ok ? "OK" : "FAILED"} | ${route}`, ok ? "WARN" : "ERROR");
        } else {
          log(`Job ${jobId} - DUPLICATE of Job ${blockingJobId}: proxy assign failed, skipped | ${route}`, "WARN");
        }
      } else {
        log(`Job ${jobId} - DUPLICATE of Job ${blockingJobId}: no proxy driver configured, skipped | ${route}`, "WARN");
      }
      continue;
    }
    if (routeKey) activeRouteMap.set(routeKey, jobId);

    // ── Delivery window gate: park jobs whose window is >60 min away ─────────
    const pickupStop = job.stops?.find((s) => s.stop_type_id === 1);
    const windowTimeFrom = pickupStop?.delivery_windows?.[0]?.time_from;
    if (windowTimeFrom) {
      // For scheduled jobs (scheduled_delivery_ts set to a future date), use that
      // date when parsing the window time — otherwise multi-day windows are always
      // parsed against today and appear to be in the past.
      const schedDate = job.scheduled_delivery_ts?.slice(0, 10);
      const windowDateStr = schedDate && schedDate > today ? schedDate : today;
      const windowDate = parsePickupWindowTime(windowTimeFrom, windowDateStr);
      if (windowDate) {
        const diffMin = (windowDate.getTime() - Date.now()) / 60_000;
        if (diffMin > 60) {
          const sendAt = new Date(windowDate.getTime() - 60 * 60 * 1000);
          const sendAtStr = vnTimestamp(sendAt);
          const [setRes, assignRes] = await Promise.all([
            updateJobSendToDriverAt(jobId, sendAtStr, env),
            assignJob(PROXY_DRIVER_ID, jobId, env),
          ]);
          if (assignRes.status === 200 && setRes.ok) {
            log(`Job ${jobId} - PARKED until ${sendAtStr} (window: ${windowTimeFrom}) | ${route}`, "INFO");
          } else {
            log(`Job ${jobId} - Park failed: set=${setRes.status} assign=${assignRes.status} | ${route}`, "WARN");
          }
          continue;
        }
      }
    }

    if (skipSmart && smartCustomerIds.has(customerId)) {
      continue;
    }

    let jobTime: Date;
    try {
      // A job with a delivery window (scheduled / released-from-parking) is shift-checked
      // against its WINDOW time on the scheduled date — NOT scheduled_delivery_ts, whose
      // time is the (often pre-shift) create time for ASAP-converted jobs. e.g. a job
      // created 05:56 with a 14:30 window must check 14:30 (on shift), not 05:56 (pre-06:00).
      const schedDate = job.scheduled_delivery_ts?.slice(0, 10) || today;
      const windowed = windowTimeFrom ? parsePickupWindowTime(windowTimeFrom, schedDate) : null;
      jobTime = windowed && !isNaN(windowed.getTime())
        ? windowed
        : parseVnTimestamp(job.scheduled_delivery_ts || job.create_ts);
      if (isNaN(jobTime.getTime())) jobTime = new Date();
    } catch {
      jobTime = new Date();
    }

    // ── Smart-assign path ────────────────────────────────────────────────────
    // Find the smart mapping that is currently on-shift (not just the first one)
    const smartMapping = config.mappings.find(
      (m) => m.customer_id === customerId && m.smart_driver_id.length > 0 && isDriverOnShift(m, jobTime)
    );

    if (smartMapping) {
      // ── 1-driver: straight assign (like fixed auto-assign) ──────────────
        if (smartMapping.smart_driver_id.length === 1) {
          let driverId   = smartMapping.smart_driver_id[0];
          let subFor: string | null = null;
          const lc1 = isDriverOnLeave(driverId, leaveEntries);
          if (lc1.onLeave) {
            const sub = resolveSubstitute(lc1.entry!);
            const who1 = jobCustomerName ?? customerId ?? "—";
            const onLeaveName1 = lc1.driverName ?? driverId;
            if (sub.status === "clash") {
              log(`Job ${jobId} - Nhiều hơn 1 SUB: ${sub.subIds.length} substitutes cover for ${onLeaveName1} now | ${route}`, "WARN");
              fail("SUB_CLASH", jobId, who1, `${onLeaveName1} nghỉ — ${sub.subIds.length} người thay cùng trực, không rõ chọn ai`, "WARN");
              continue;
            }
            if (sub.status === "none") {
              log(`Job ${jobId} - SMART(1) SKIP: ${onLeaveName1} on leave (${lc1.reason}), no substitute covers now | ${route}`, "WARN");
              fail("ON_LEAVE", jobId, who1, `${onLeaveName1} nghỉ (${lc1.reason}) — không có người thay đang trực`, "WARN");
              continue;
            }
            subFor = lc1.driverName ?? driverId;
            driverId = sub.subId;
          }
          if (smartMapping.alt_drop_off_id) {
            const _tAlt = Date.now();
            const alt = await applyAltDropoff(jobId, smartMapping.alt_drop_off_id, job.stops ?? [], env, log);
            altMs += Date.now() - _tAlt;
            if (!alt.ok) continue;
          }
          try {
            // Assign via the update endpoint — it returns the driver, so the name comes
            // straight from Cartrack's response (no driver-list fetch needed).
            const { status: apiStatus, body, driverName: ctName } = await assignJobViaUpdate(
              jobId, driverId, env, allGpsDrivers.find((d) => d.delivery_driver_id === driverId)
            );
            if (apiStatus === 200) {
              const driverName = ctName || (subFor ? driverId : smartMapping.first_name_last_name) || driverId;
              const who = subFor ? `${driverName} (sub for ${subFor})` : driverName;
              log(`Job ${jobId} - SMART(1): ${who} | ${route}`, "OK");
            } else if (isDriverUnavailable(body)) {
              // One smart driver, on-break/offline → recurs every cycle. Route to
              // Cần xử lý instead of spamming the live log (dropped by shouldStore).
              const who2 = jobCustomerName ?? customerId ?? "—";
              log(`Job ${jobId} - SMART(1) assigned driver on-break or offline | ${route}`, "WARN");
              fail("UNAVAILABLE", jobId, who2, "Giao Nhận Mẫu (smart) được phân công đang nghỉ giải lao/offline");
            } else {
              log(`Job ${jobId} - SMART(1) failed: ${friendlyError(body)} | ${route}`, "ERROR");
            }
          } catch (e) {
            log(`Job ${jobId} - SMART(1) error: ${e} | ${route}`, "ERROR");
          }
          continue;
        }

        // ── Multi-driver: haversine → Goong rank, assign top ───────────────
        const pickupStop = job.stops.find((s) => s.stop_type_id === 1);
        if (!pickupStop?.latitude || !pickupStop?.longitude) {
          const who = jobCustomerName ?? customerId ?? "—";
          log(`Job ${jobId} - SMART skipped: pickup has no GPS | ${route}`, "ERROR");
          fail("NO_GPS", jobId, who, "Điểm lấy mẫu không có toạ độ GPS — không thể xếp tài xế gần nhất");
          continue;
        }

        // Build the candidate pool from the configured smart drivers. When a
        // configured driver is on leave and exactly one substitute covers now,
        // rank the SUBSTITUTE in their place — using the sub's own GPS/route
        // data — so the nearest *actually-working* driver wins, not the absent
        // one's stale location. The on-leave driver stays in the pool only when
        // their sub can't be ranked (clash / no cover / sub has no coords); the
        // assign loop below resolves those the legacy way (swap at assign time).
        const driverById = new Map<string, Driver>(
          allGpsDrivers.map((d): [string, Driver] => [d.delivery_driver_id, d])
        );
        const subForByDriverId = new Map<string, string>(); // ranked driver id → on-leave name they cover
        const candidates: Driver[] = [];
        const candidateIds = new Set<string>();
        for (const cfgId of smartMapping.smart_driver_id) {
          let cand = driverById.get(cfgId);
          let subFor: string | null = null;
          const lc = isDriverOnLeave(cfgId, leaveEntries);
          if (lc.onLeave) {
            const sub = resolveSubstitute(lc.entry!);
            if (sub.status === "ok") {
              const subDriver = driverById.get(sub.subId);
              if (subDriver && phase1Coords.has(sub.subId)) {
                cand = subDriver;                 // rank the substitute, not the absent driver
                subFor = lc.driverName ?? cfgId;
              }
              // sub has no rankable coords → keep cfg driver; assign loop swaps at assign time
            }
            // clash / none → keep cfg driver; assign loop emits SUB_CLASH / skips
          }
          if (!cand) continue;                                // configured driver not in fleet list
          if (!phase1Coords.has(cand.delivery_driver_id)) continue;
          if (candidateIds.has(cand.delivery_driver_id)) {    // dedup (sub == another cfg driver, or two leaves → same sub)
            if (subFor && !subForByDriverId.has(cand.delivery_driver_id)) {
              subForByDriverId.set(cand.delivery_driver_id, subFor);
            }
            continue;
          }
          candidateIds.add(cand.delivery_driver_id);
          candidates.push(cand);
          if (subFor) subForByDriverId.set(cand.delivery_driver_id, subFor);
        }
        if (candidates.length === 0) {
          const who = jobCustomerName ?? customerId ?? "—";
          log(`Job ${jobId} - SMART skipped: 0/${smartMapping.smart_driver_id.length} configured drivers available (GPS or start_location) | ${route}`, "WARN");
          fail("NO_DRIVER", jobId, who, `0/${smartMapping.smart_driver_id.length} tài xế cấu hình có toạ độ (GPS/điểm xuất phát)`, "WARN");
          continue;
        }

        // Haversine pre-rank — uses effective coords (GPS if available, else start_location)
        const preRanked = candidates
          .map((d) => {
            const c = phase1Coords.get(d.delivery_driver_id)!;
            return {
              d,
              hkm: Math.round(haversineKm(pickupStop.latitude!, pickupStop.longitude!, c.lat, c.lon) * 10) / 10,
            };
          })
          .sort((a, b) => a.hkm - b.hkm);

        // Goong re-rank: reference stop → pickup. Every candidate's reference
        // points (primary ref; for "Next Stop" also the last completed stop —
        // driver may still be there; min of both wins) resolve in ONE pass per
        // job: self-pairs are 0 km for free, repeats and known pairs come from
        // the Redis cache, and only the misses ride a single multi-origin
        // matrix request — instead of up to two 1×1 Goong round trips per
        // candidate. Nulls still fall back to haversine per point.
        const pickupPt = { lat: pickupStop.latitude!, lon: pickupStop.longitude! };
        const prepped = preRanked.map(({ d, hkm }) => {
          const info = smartRouteData[d.delivery_driver_id];
          const ref = info?.ref ?? null;
          const refPts: { lat: number; lon: number }[] = ref ? [{ lat: ref.lat, lon: ref.lon }] : [];
          if (ref && ref.altLat != null && ref.altLon != null) refPts.push({ lat: ref.altLat, lon: ref.altLon });
          return { d, hkm, info, ref, refPts };
        });
        const _tGoong = Date.now();
        const flatRoads = await roadDistancesToPoint(prepped.flatMap((p) => p.refPts), pickupPt);
        goongMs += Date.now() - _tGoong;
        // Rank by travel TIME (Goong eta_mins) instead of road distance when
        // SMART_RANK_BY_DURATION=1. Duration reflects HCMC traffic/road speed, so the
        // driver who *arrives soonest* wins — not merely the one fewest km away. eta_mins
        // is already returned + cached alongside distance_km, so this costs no extra Goong
        // call. The comparator is unit-agnostic (it just compares sortDist); gpsKm stays
        // in km for the en-route GPS tiebreak band.
        const rankByDuration = process.env.SMART_RANK_BY_DURATION === "1";
        let ptCursor = 0;
        const nowMin = vnMinutesSinceMidnight();
        const withGoong = prepped.map(({ d, hkm, info, ref, refPts }) => {
          const workload = info?.workload ?? 0;
          const tiebreakTs = ref?.tiebreakTs ?? null;
          const priority = ref ? ROUTE_STATE_PRIORITY[ref.label] : 0;
          const tbTime   = hhmmVn(tiebreakTs);
          const labelTag = ref ? `[${ref.label}${tbTime ? ` · ${TIEBREAK_VERB[ref.label]} ${tbTime}` : ""}] ` : "";
          const jobsDone = info?.jobsDone ?? 0;
          const name = `${d.first_name} ${d.last_name}`.trim();
          if (!ref) {
            // No route reference → only the live-GPS haversine is available. In duration
            // mode convert it to estimated minutes so it ranks on the same scale.
            const sortDist = rankByDuration ? Math.round(hkm * STRAIGHT_KM_TO_MIN) : hkm;
            const distLabel = rankByDuration
              ? `~${Math.round(hkm * STRAIGHT_KM_TO_MIN)}min GPS est (load ${workload})`
              : `${hkm}km GPS (load ${workload})`;
            return { d, sortDist, priority, label: null, gpsKm: hkm, idleBand: idleBand(tiebreakTs, nowMin), workload, tiebreakTs, jobsDone, name, distLabel };
          }
          const entries = refPts.map(() => flatRoads[ptCursor++] ?? null);
          const roads = entries.map((e) => e?.distance_km ?? null);
          const mins  = entries.map((e) => e?.eta_mins ?? null);
          const straights = refPts.map(
            (p) => Math.round(haversineKm(p.lat, p.lon, pickupPt.lat, pickupPt.lon) * 10) / 10
          );
          // Per-point effective cost in the ranking unit (mins or km): Goong value first,
          // haversine-derived fallback second. bestIdx = closest reference point.
          const effPerPoint = refPts.map((_, i) =>
            rankByDuration
              ? (mins[i] ?? Math.round(straights[i] * STRAIGHT_KM_TO_MIN))
              : (roads[i] ?? straights[i])
          );
          const bestIdx = effPerPoint.reduce((bi, e, i) => (e < effPerPoint[bi] ? i : bi), 0);
          const roadKm = roads[bestIdx];
          const roadMin = mins[bestIdx];
          const refHkm = straights[bestIdx];
          const sortDist = effPerPoint[bestIdx];
          const refName  = ref.customerName ? `@${ref.customerName} ` : "";
          const minTag   = refPts.length > 1 ? (bestIdx === 1 ? "via prev " : "via next ") : "";
          const distLabel = rankByDuration
            ? (roadMin != null
                ? `${labelTag}${hkm}km GPS, ${minTag}${refName}→ ${roadMin}min road (${roadKm}km) (load ${workload})`
                : `${labelTag}${hkm}km GPS, ${minTag}${refName}→ ~${Math.round(refHkm * STRAIGHT_KM_TO_MIN)}min est (${refHkm}km straight) (load ${workload})`)
            : (roadKm != null
                ? `${labelTag}${hkm}km GPS, ${minTag}${refName}→ ${roadKm}km road (load ${workload})`
                : `${labelTag}${hkm}km GPS, ${minTag}${refName}→ ${refHkm}km straight (load ${workload})`);
          return { d, sortDist, priority, label: ref.label, gpsKm: hkm, idleBand: idleBand(tiebreakTs, nowMin), workload, tiebreakTs, jobsDone, name, distLabel };
        });
        withGoong.sort(rankingComparator);

        const top        = withGoong[0];
        const driverName = `${top.d.first_name} ${top.d.last_name}`.trim();
        const rankStr    = withGoong.slice(0, 3)
          .map((x, i) => `${i + 1}. ${x.d.first_name} ${x.d.last_name} (${x.distLabel})`)
          .join(" | ");
        if (smartMapping.alt_drop_off_id) {
          const _tAlt = Date.now();
          const alt = await applyAltDropoff(jobId, smartMapping.alt_drop_off_id, job.stops ?? [], env, log);
          altMs += Date.now() - _tAlt;
          if (!alt.ok) continue;
        }
        // Try candidates in ranked order; fall through to next if on-break/offline.
        let assigned = false;
        let subClash = false;
        for (let attempt = 0; attempt < withGoong.length; attempt++) {
          const candidate = withGoong[attempt];
          const candidateName = `${candidate.d.first_name} ${candidate.d.last_name}`.trim();

          // A pre-swapped candidate already IS the substitute (ranked by their
          // own location above) — carry that label straight through. Otherwise
          // this may still be an on-leave driver whose sub couldn't be ranked
          // (clash / no cover / sub lacks coords); resolve them the legacy way.
          let targetId = candidate.d.delivery_driver_id;
          let subFor: string | null = subForByDriverId.get(targetId) ?? null;
          if (!subFor) {
            const lc = isDriverOnLeave(targetId, leaveEntries);
            if (lc.onLeave) {
              const sub = resolveSubstitute(lc.entry!);
              if (sub.status === "clash") {
                const who = pickupStop.customer_name ?? jobCustomerName ?? customerId ?? "—";
                const onLeaveName = lc.driverName ?? candidateName;
                log(`Job ${jobId} - Nhiều hơn 1 SUB: ${sub.subIds.length} substitutes cover for ${onLeaveName} now | ${route}`, "WARN");
                fail("SUB_CLASH", jobId, who, `${onLeaveName} nghỉ — ${sub.subIds.length} người thay cùng trực, không rõ chọn ai`, "WARN");
                subClash = true;
                break;
              }
              if (sub.status === "none") {
                log(`Job ${jobId} - SMART #${attempt + 1} ${candidateName}: on leave (${lc.reason}), no substitute — trying next best candidates | ${route}`, "INFO");
                continue;
              }
              targetId = sub.subId;
              subFor = lc.driverName ?? candidateName;
            }
          }

          try {
            // Substitute → assign via update endpoint to read the sub's real name
            // from Cartrack's response (sub#_name in the sheet is reference-only).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let apiStatus: number, body: any, ctName: string | null = null;
            if (subFor) {
              const r = await assignJobViaUpdate(jobId, targetId, env, driverById.get(targetId));
              apiStatus = r.status; body = r.body; ctName = r.driverName;
            } else {
              const r = await assignJob(targetId, jobId, env, driverById.get(targetId));
              apiStatus = r.status; body = r.body;
            }
            if (apiStatus === 200) {
              const tag = attempt > 0 ? `[#${attempt + 1}] ` : "";
              const who = subFor ? `${ctName || targetId} (sub for ${subFor})` : rankStr;
              log(`Job ${jobId} - SMART ${tag}: ${who} | ${route}`, "OK");
              assigned = true;
              break;
            } else if (isDriverUnavailable(body)) {
              const who = subFor ? `sub ${ctName || targetId}` : candidateName;
              log(`Job ${jobId} - SMART #${attempt + 1} ${who}: on-break or offline, trying next best candidates | ${route}`, "WARN");
            } else {
              log(`Job ${jobId} - SMART failed: ${friendlyError(body)} | ${route}`, "ERROR");
              break;
            }
          } catch (e) {
            log(`Job ${jobId} - SMART error: ${e} | ${route}`, "ERROR");
            break;
          }
        }
        if (subClash) continue;
        if (!assigned) {
          const names = withGoong.map((x) => `${x.d.first_name} ${x.d.last_name}`.trim()).join(", ");
          const who = pickupStop.customer_name ?? jobCustomerName ?? customerId ?? "—";
          log(`Job ${jobId} - SMART: all ${withGoong.length} candidate(s) on-break or unavailable (${names}) | ${route}`, "ERROR");
          fail("UNAVAILABLE", jobId, who, `${withGoong.length} tài xế đều đang nghỉ giải lao/offline: ${names}`);
        }
        continue;
    }

    // ── Fixed driver path (original logic) ───────────────────────────────────
    const [drivers, status] = getDriversOnDuty(config, customerId, jobTime);

    if (status === "no_mapping") {
      const who = jobCustomerName ?? customerId ?? "—";
      log(`Job ${jobId} - NO MAPPING | ${route}`, "ERROR");
      fail("NO_MAPPING", jobId, who, "Khách hàng chưa được cấu hình trong Google Sheet");
      continue;
    }

    if (status === "no_driver") {
      const shiftInfo = drivers
        .map((m) => `${fmtShift(m.shift_start)}–${fmtShift(m.shift_end)}`)
        .join(", ");
      const jt = vnHoursMinutes(jobTime);
      const hhmm = `${String(jt.hours).padStart(2, "0")}:${String(jt.minutes).padStart(2, "0")}`;
      const who = jobCustomerName ?? customerId ?? "—";
      log(`Job ${jobId} - NO DRIVER ON DUTY at ${hhmm}, Shifts: ${shiftInfo} | ${route}`, "ERROR");
      fail("NO_DRIVER", jobId, who, `Không có tài xế trực lúc ${hhmm} · Ca: ${shiftInfo || "—"}`);
      continue;
    }

    if (status === "clash") {
      const driverList = drivers
        .map((m) => `${m.first_name_last_name || "?"} ${fmtShift(m.shift_start)}–${fmtShift(m.shift_end)}`)
        .join(", ");
      const jt = vnHoursMinutes(jobTime);
      const hhmm = `${String(jt.hours).padStart(2, "0")}:${String(jt.minutes).padStart(2, "0")}`;
      const who = jobCustomerName ?? customerId ?? "—";
      log(`Job ${jobId} - CLASH: ${drivers.length} drivers on duty at ${hhmm}, ${driverList} | ${route}`, "WARN");
      fail("CLASH", jobId, who, `${drivers.length} tài xế cùng trực lúc ${hhmm}: ${driverList}`, "WARN");
      continue;
    }

    // Exactly one driver on duty
    const mapping = drivers[0];
    let driverId = mapping.driver_id;
    if (!driverId) continue;

    let subFor: string | null = null;
    const lcFixed = isDriverOnLeave(driverId, leaveEntries);
    if (lcFixed.onLeave) {
      const sub = resolveSubstitute(lcFixed.entry!);
      const who = jobCustomerName ?? customerId ?? "—";
      const onLeaveName = lcFixed.driverName ?? driverId;
      if (sub.status === "clash") {
        log(`Job ${jobId} - Nhiều hơn 1 SUB: ${sub.subIds.length} substitutes cover for ${onLeaveName} now | ${route}`, "WARN");
        fail("SUB_CLASH", jobId, who, `${onLeaveName} nghỉ — ${sub.subIds.length} người thay cùng trực, không rõ chọn ai`, "WARN");
        continue;
      }
      if (sub.status === "none") {
        log(`Job ${jobId} - SKIP: ${onLeaveName} on leave (${lcFixed.reason}), no substitute covers now | ${route}`, "WARN");
        fail("ON_LEAVE", jobId, who, `${onLeaveName} nghỉ (${lcFixed.reason}) — không có người thay đang trực`, "WARN");
        continue;
      }
      subFor = lcFixed.driverName ?? driverId;
      driverId = sub.subId;
    }

    // A broken sheet cell (#REF!, #N/A, …) would build a malformed assign URL
    // (/jobs/assign/#REF → Cartrack HTML 404). Catch it here with a clear,
    // visible message instead of a cryptic JSON-parse crash.
    if (!isValidDriverId(driverId)) {
      const who = jobCustomerName ?? customerId ?? "—";
      log(`Job ${jobId} - invalid driver_id "${driverId}" | ${route}`, "ERROR");
      fail("INVALID_DRIVER", jobId, who, `driver_id sai trong Sheet: "${driverId}" — cần sửa Google Sheet`);
      continue;
    }

    // Alt drop-off: swap the dropoff customer before assigning. Keep the result so the
    // post-assign block can read the new dropoff name + coords without a getJobDetails.
    let altResult: AltDropoffResult | null = null;
    if (mapping.alt_drop_off_id) {
      const _tAlt = Date.now();
      altResult = await applyAltDropoff(jobId, mapping.alt_drop_off_id, job.stops ?? [], env, log);
      altMs += Date.now() - _tAlt;
      if (!altResult.ok) continue;
    }

    try {
      // Assign via the update endpoint — returns the driver, so the name comes from
      // Cartrack's response (no driver-list fetch). Single driver, no on-break fallback.
      const { status: apiStatus, body, driverName: ctName } = await assignJobViaUpdate(
        jobId, driverId, env, allGpsDrivers.find((d) => d.delivery_driver_id === driverId)
      );

      if (apiStatus === 200) {
        // Everything for the log + Zalo comes from data already in hand — no
        // getJobDetails. Pickup is unchanged → read off job.stops. For an alt-dropoff
        // job the dropoff was swapped, so its new name + coords come from the
        // applyAltDropoff result (it already fetched the alt customer record).
        // Name from Cartrack's assign response, then sheet, then UUID.
        const respDriverName = ctName || (subFor ? driverId : mapping.first_name_last_name) || driverId;
        const pickupStop  = job.stops?.find((s) => s.stop_type_id === 1);
        const dropoffStop = job.stops?.find((s) => s.stop_type_id === 2);
        const pickupName  = pickupStop?.customer_name ?? jobCustomerName ?? "N/A";
        const pickupLat = pickupStop?.latitude;
        const pickupLon = pickupStop?.longitude;
        const dropoffName = altResult?.dropoffName ?? dropoffStop?.customer_name ?? "N/A";
        const dropoffLat = altResult ? altResult.dropoffLat : dropoffStop?.latitude;
        const dropoffLon = altResult ? altResult.dropoffLon : dropoffStop?.longitude;

        log(
          `Job ${jobId} - ${subFor ? `${respDriverName} (sub for ${subFor})` : respDriverName} | ${pickupName} → ${dropoffName}`,
          "OK"
        );

        // Build route link
        const routeLink = buildGmapsRouteLink(pickupLat, pickupLon, dropoffLat, dropoffLon);

        // Zalo notification. When a sub covers, notify the SUB on their own Zalo
        // — not the on-leave driver. The sub's tokens come from any mapping row
        // where they are the driver_id; if the sub has no token row, send nothing
        // (better silent than pinging the driver who's off).
        let bot_token = mapping.bot_token;
        let chat_id = mapping.chat_id;
        if (subFor) {
          const subMapping = config.mappings.find(
            (m) => m.driver_id === driverId && m.bot_token && m.chat_id
          );
          bot_token = subMapping?.bot_token ?? "";
          chat_id = subMapping?.chat_id ?? "";
        }
        if (bot_token && chat_id) {
          const lines = [
            `New job assigned: ${jobId}`,
            `Pickup (Stop 1): ${pickupName !== "N/A" ? pickupName : jobCustomerName ?? "N/A"}`,
            `Dropoff (Stop 2): ${dropoffName}`,
          ];
          if (routeLink) {
            lines.push(`Route (motorbike): ${routeLink}`);
          } else {
            lines.push("Route: (missing coordinates)");
          }

          const _tZalo = Date.now();
          const sent = await sendZaloMessage(
            bot_token,
            chat_id,
            lines.join("\n")
          );
          zaloMs += Date.now() - _tZalo;
          if (sent) log("Zalo notification sent");
        }

        // Route optimisation — pilot drivers only. Defer + dedupe: collect the
        // driver now; run optimize once per driver AFTER the loop (off the per-job
        // critical path, one call per driver instead of one per assigned job).
        const pilotDrivers = (process.env.ROUTE_OPTIMIZE_PILOT ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (pilotDrivers.includes(driverId)) driversToOptimize.add(driverId);
      } else {
        const pickupName = job.stops?.find((s) => s.stop_type_id === 1)?.customer_name ?? jobCustomerName ?? "N/A";
        if (isDriverUnavailable(body)) {
          // The single on-duty driver is on-break/offline → fails identically every
          // cycle. Surface in Cần xử lý, not as a repeating live-log ERROR.
          log(`Job ${jobId} - assigned driver on-break or offline | ${route}`, "WARN");
          fail("UNAVAILABLE", jobId, pickupName, "Giao Nhận Mẫu được phân công đang nghỉ giải lao/offline");
        } else {
          log(`Job ${jobId} - failed: ${friendlyError(body)} | ${route}`, "ERROR");
        }
      }
    } catch (e) {
      log(`Job ${jobId} - error: ${e} | ${route}`, "ERROR");
    }
    } while (false);
  };

  // Run the per-job worker. ASSIGN_PARALLEL_LOOP=1 overlaps the ~6-9s assign calls
  // in bounded chunks; dedup stays safe because each job claims its route
  // synchronously (activeRouteMap.set) before its first await. Default = sequential.
  const LOOP_CONCURRENCY = 10; // matches the proxy-release bound; 5 left peak cycles paying a second ~10s round for jobs 6-10
  if (process.env.ASSIGN_PARALLEL_LOOP === "1") {
    for (let i = 0; i < jobs.length; i += LOOP_CONCURRENCY) {
      await Promise.all(jobs.slice(i, i + LOOP_CONCURRENCY).map(processJob));
    }
  } else {
    for (const job of jobs) {
      await processJob(job);
    }
  }

  // Deferred route-optimise: one bounded-parallel call per pilot driver assigned
  // this cycle — off the per-job path and deduped (one call/driver, not per job).
  if (driversToOptimize.size > 0) {
    const _tOpt = Date.now();
    const ids = [...driversToOptimize];
    for (let i = 0; i < ids.length; i += 5) {
      await Promise.all(ids.slice(i, i + 5).map(async (id) => {
        const ok = await optimizeDriverRoute(id, vnDate(), env);
        log(`Route optimise for ${id}: ${ok ? "triggered" : "skipped (no cookie or failed)"}`, ok ? "INFO" : "WARN");
      }));
    }
    optimizeMs += Date.now() - _tOpt;
  }

  const _loopMs = Date.now() - tMark;
  const _assignIsh = _loopMs - goongMs - altMs - zaloMs - optimizeMs;
  clog(`[timing] loop detail: ${jobs.length} job(s) in ${_loopMs}ms | goong ${goongMs} alt ${altMs} zalo ${zaloMs} optimize ${optimizeMs} assign~${_assignIsh}ms`);
  phase("assign-loop");

  if (!onlyJobIds) {
    await Promise.all([
      setHeldJobs(heldJobs),
      setFailedJobs(failedJobs),
      setPickupWarnings(computePickupWarnings(assignedJobsToday ?? [], today)),
    ]);
  }
  return logs;
  } finally {
    // Both follow-up steps need today's status 2/4/5 lists. They came from the
    // single getJobsByDate partition above, so this normally re-fetches nothing.
    // Each falls back to a per-status fetch only if that partition is null (the
    // combined fetch threw before populating it). Jobs that changed state
    // mid-cycle (assigned 2→4, completed 4→5) stay visible: the dedup pot is the
    // s2∪s4 union, and a just-assigned job's stops can't be "started" yet, so
    // via-legs couldn't act on it this cycle anyway — the next cycle sees it fresh.
    const followToday = vnDate();
    let shared: { s2: Job[]; s4: Job[]; s5: Job[] } | undefined;
    try {
      const [s2, s4, s5] = await Promise.all([
        cycleStartS2 ?? getJobsByStatusAndDate(2, followToday, env),
        assignedJobsToday ?? getJobsByStatusAndDate(4, followToday, env),
        cycleS5 ?? getJobsByStatusAndDate(5, followToday, env),
      ]);
      shared = { s2, s4, s5 };
    } catch (e) {
      log(`Follow-up prefetch failed, each step will self-fetch: ${e}`, "WARN");
    }

    // Shared by return-trips + cleanup to gate substitutes on the on-leave
    // driver's shift. Cached (5-min TTL) — the cycle above already populated it.
    const followLeave = await loadLeaveEntries().catch(() => []);

    // Via-legs and return trips are independent (different labels, different triggers,
    // same read-only prefetch) — run them concurrently so follow-ups cost the slower
    // of the two instead of their sum (each can hold ~13-15s Cartrack creation POSTs).
    // Pass the shared prefetch so neither step re-fetches the status 2/4/5 lists; falls
    // back to self-fetch when `shared` is undefined (prefetch above failed).
    clog(`[follow-ups] via-legs + return-trips start (t=${Date.now() - tStart}ms)`);
    const followStep = async (name: string, failMsg: string, fn: () => Promise<void>) => {
      const t0 = Date.now();
      try {
        await fn();
      } catch (e) {
        log(`${failMsg}: ${e}`, "ERROR");
      }
      clog(`[follow-ups] ${name} done: ${Date.now() - t0}ms`);
    };
    await Promise.all([
      followStep("via-legs", "Via-leg hook failed", () =>
        detectAndCreateViaLegs(env, log, shared && { s4: shared.s4, s5: shared.s5 })),
      followStep("return-trips", "Return-trip hook failed", () =>
        detectAndCreateReturnTrips(config, env, log, shared, followLeave)),
    ]);
    // Cleanup runs last: it acts on via-legs/returns the steps above may have just
    // created, and reuses the same prefetch. No-op unless CLEANUP_STALE_TRIPS=1.
    clog(`[follow-ups] cleanup start (t=${Date.now() - tStart}ms)`);
    try {
      await cleanupStaleTrips(config, env, log, shared, followLeave);
    } catch (e) {
      log(`Cleanup hook failed: ${e}`, "ERROR");
    }
    phase("follow-ups");
  }
}

function fmtShift(t: { hours: number; minutes: number } | null): string {
  if (!t) return "??";
  return `${String(t.hours).padStart(2, "0")}:${String(t.minutes).padStart(2, "0")}`;
}
