import type { Config, Driver, Job, LogEntry, LogLevel, Mapping, PickupWarning, TimelineRoute } from "./types";
import { getDrivers, getUnassignedJobs, getDriverJobs, getAllAssignedDriverJobs, assignJob, assignJobViaUpdate, getCustomerById, updateJobStops, updateJobSendToDriverAt, unassignJob, optimizeDriverRoute, getFleetwebCookie, getJobsByStatusAndDate, JSONRPC_URL, PROXY_DRIVER_ID, type Env } from "./cartrack";
import { sendZaloMessage } from "./zalo";
import { PSC_TINH_LABEL } from "./psc-config";
import { detectAndCreateReturnTrips, PSC_RETURN_LABEL } from "./return-trips";
import { detectAndCreateViaLegs, PSC_VIA_LABEL } from "./via-legs";
import { setHeldJobs, setPickupWarnings, type HeldJob } from "./smart-log-kv";
import { isValidDriverId } from "./config";
import {
  vnDate,
  vnTimestamp,
  vnHoursMinutes,
  vnMinutesSinceMidnight,
  vnDayWindow,
  parseVnTimestamp,
} from "./time";
import { haversineKm, goongDistanceKm } from "./distance";
import { isCompletedOrRejectedStop } from "./job-filters";
import { selectReferenceStop, computeStopStats, rankingComparator, ROUTE_STATE_PRIORITY, type RefStop, type RefLabel } from "./smart-rank";

const REST_BASE = "https://fleetapi-vn.cartrack.com/rest/delivery";

const DUPLICATE_REJECT_REASON =
  "Yêu cầu liền kề vẫn đang được thực hiện, quý khách vui lòng đợi thêm giây lát hoặc liên hệ Diag nếu cần được hỗ trợ!";

// Jobs carrying any of these labels are exempt from duplicate detection.
// PSC tỉnh jobs are multi-leg provincial routes — the same pickup→dropoff pair
// is expected to repeat across different legs and should never be blocked.
const DUPLICATE_EXEMPT_LABELS = [PSC_TINH_LABEL, PSC_RETURN_LABEL];

// ── Duplicate-check helpers ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAssignedJobsToday(vnDate: string, auth: string): Promise<any[]> {
  // Filter by scheduled_delivery_ts (not create_ts): the duplicate-route map and the
  // pickup warnings care about what's being DELIVERED today, not what was created today
  // — so a job created yesterday for today is included, and one created today for a
  // future day is not. Matches the main cycle's getJobsByStatusAndDate(2) filter.
  const params = new URLSearchParams({
    "filter[job_status_id]": "4",
    "filter[scheduled_delivery_ts_from]": `${vnDate} 00:00:00`,
    "filter[scheduled_delivery_ts_to]":   `${vnDate} 23:59:59`,
    limit: "1000",
  });
  try {
    const res = await fetch(`${REST_BASE}/jobs?${params}`, {
      headers: { Authorization: auth, "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.data ?? [];
  } catch {
    return [];
  }
}

// Returns Map<"pickup_id:dropoff_id", blocking_job_id> for assigned jobs today
// where the pickup stop is not yet completed/rejected and window is not >1h away.
function buildActiveRouteMap(jobs: any[]): Map<string, number> {
  const result = new Map<string, number>();

  // Current VN time in minutes-since-midnight
  const nowMinutes = vnMinutesSinceMidnight();

  for (const job of jobs) {
    if (job.job_status_id === 7 || job.job_status_id === 3) continue;
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


function computePickupWarnings(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assignedJobs: any[],
  today: string,
): PickupWarning[] {
  const now = Date.now();
  const THIRTY_MIN_MS  = 30 * 60 * 1000;
  const FIFTEEN_MIN_MS = 15 * 60 * 1000;

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickup = (job.stops ?? [] as any[]).find((s: any) => s.stop_type_id === 1);
    if (!pickup) continue;
    if (pickup.activity_started_ts) continue;
    // Guard: skip if stop is already completed or rejected
    if (isCompletedOrRejectedStop(pickup.stop_status_id ?? 0)) continue;

    const hasWindow =
      Array.isArray(pickup.delivery_windows) && pickup.delivery_windows.length > 0;

    let reason: PickupWarning["reason"] | null = null;
    let extra: Partial<PickupWarning> = {};

    if (!hasWindow) {
      // Case 1: no window — warn if sent to driver 30+ min ago
      const sentAt = parseSendToDriverAt(job.send_to_driver_at);
      if (!sentAt) continue;
      const elapsed = now - sentAt.getTime();
      if (elapsed >= THIRTY_MIN_MS) {
        reason = "overdue";
        extra = { minutes_late: Math.floor(elapsed / 60000) - 30 };
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

    warnings.push({
      job_id: job.job_id,
      reference_number: job.reference_number ?? null,
      pickup_customer_name: pickup.customer_name ?? null,
      driver_id: driverId,
      driver_name: driverName,
      reason,
      ...extra,
    });
  }

  return warnings;
}

async function rejectJobAsDuplicate(jobId: number, auth: string, cookie: string): Promise<boolean> {
  try {
    const res = await fetch(JSONRPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth, Cookie: cookie },
      body: JSON.stringify({
        version: "2.0",
        method: "delivery_reject_job",
        id: 1,
        params: { data: { jobIds: [jobId], rejectReason: DUPLICATE_REJECT_REASON } },
      }),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok && !data.error;
  } catch {
    return false;
  }
}

// ── Smart-assign helpers ───────────────────────────────────────────────────

type DriverRouteInfo = { ref: RefStop | null; label: RefLabel | null; workload: number; lastCompletedTs: string | null; jobsDone: number };

async function fetchSmartRouteData(
  dateVn: string, auth: string, cookie: string,
  shiftStartByDriverId: Record<string, string | null>
): Promise<Record<string, DriverRouteInfo>> {
  try {
    const res = await fetch(JSONRPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth, Cookie: cookie },
      body: JSON.stringify({
        version: "2.0", method: "delivery_timeline_route_list", id: 1,
        params: { data: { scheduleType: "scheduled", filter: vnDayWindow(dateVn) }},
      }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const routes: TimelineRoute[] = data.result?.routes ?? [];

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
  } catch {
    return {};
  }
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
 * Sets each job back to unassigned so the next assign cycle picks it up.
 */
async function releaseDueProxyJobs(dateVn: string, env: Env, log: (msg: string, level?: LogLevel) => void): Promise<void> {
  // No date filter — multi-day parked jobs are created on a previous day so
  // filtering by create_ts = today would miss them.
  const proxyJobs = await getAllAssignedDriverJobs(PROXY_DRIVER_ID, env);
  const now = Date.now();
  for (const job of proxyJobs) {
    const sendAt = parseSendToDriverAt(job.send_to_driver_at);
    if (!sendAt || sendAt.getTime() > now) continue;
    const { ok, status } = await unassignJob(job.job_id, env);
    if (ok) {
      log(`Job ${job.job_id} - RELEASED from proxy driver (was parked until ${job.send_to_driver_at})`, "INFO");
    } else {
      log(`Job ${job.job_id} - Release failed (HTTP ${status})`, "WARN");
    }
  }
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

  try {
  // ── Release parked proxy jobs whose send_to_driver_at has passed ──────────
  // Skipped on a targeted manual assign — that's not a full cycle.
  const today = vnDate();
  if (!onlyJobIds) await releaseDueProxyJobs(today, env, log);

  // Fetch unassigned jobs by scheduled_delivery_ts = today.
  // Using scheduled_delivery_ts (not create_ts) means multi-day parked jobs
  // released from the proxy driver are found on their scheduled day regardless
  // of when they were created.
  let jobs: Job[];
  try {
    jobs = await getJobsByStatusAndDate(2, today, env);
  } catch (e) {
    log(`Error fetching jobs: ${e}`, "ERROR");
    return logs;
  }

  // Targeted manual assign: narrow to just the requested job(s).
  if (onlyJobIds) jobs = jobs.filter((j) => onlyJobIds.has(j.job_id));

  // Jobs held back this cycle because a stop has a note (full cycle only).
  const heldJobs: HeldJob[] = [];

  if (jobs.length === 0) {
    log("No unassigned jobs");
    if (!onlyJobIds) await setHeldJobs(heldJobs);
    return logs;
  }

  log(`Found ${jobs.length} unassigned job(s)`);

  // ── Fetch assigned jobs once — reused for duplicate-check AND warnings ──────
  // Fire it now but await it after the smart-driver fetch below, so the two
  // independent reads overlap instead of running as two serial waves.
  const authSuffix = env === "uat" ? "_UAT" : "";
  const auth = process.env[`CARTRACK_AUTH${authSuffix}`] ?? "";
  const assignedJobsPromise = fetchAssignedJobsToday(today, auth);
  let rejectCookie: string | null = null;

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
    const auth   = process.env.CARTRACK_AUTH ?? "";
    const [fetchedDrivers, cookie] = await Promise.all([getDrivers(env), getFleetwebCookie()]);
    allGpsDrivers = fetchedDrivers.filter((d) =>
      (d.latitude != null && d.longitude != null) || !!d.start_location_customer_id
    );
    const shiftStartByDriverId: Record<string, string | null> = {};
    for (const d of allGpsDrivers) shiftStartByDriverId[d.delivery_driver_id] = d.shift_time_start ?? null;
    if (cookie && auth) {
      smartRouteData = await fetchSmartRouteData(vnDate(), auth, cookie, shiftStartByDriverId);
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
    await Promise.all(
      [...startLocIdsNeeded].map(async (cid) => {
        const customerData = await getCustomerById(cid, env);
        const c = customerData?.data;
        if (c?.latitude != null && c?.longitude != null) {
          startLocCoords.set(cid, { lat: c.latitude, lon: c.longitude, name: c.customer_name ?? null });
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

  // Resolve the assigned-jobs fetch kicked off above (it ran in parallel with the
  // smart-driver fetch). Reused for duplicate-check (this loop) and pickup warnings.
  const assignedJobsToday = await assignedJobsPromise;
  const activeRouteMap = buildActiveRouteMap(assignedJobsToday);

  for (const job of jobs) {
    const jobId = job.job_id;
    const customerId = getCustomerIdFromJob(job);
    const jobCustomerName = getCustomerNameFromJob(job);

    if (jobHasNotes(job)) {
      // Jobs with a delivery window bypass the note gate — the window parking path
      // handles them. The note is driver context, not a blocker for scheduled jobs.
      const hasWindow = !!(job.stops?.find((s) => s.stop_type_id === 1)?.delivery_windows?.[0]?.time_from);
      if (!hasWindow) {
        if (!onlyJobIds?.has(jobId)) {
          log(`Job ${jobId} - SKIPPED (has note): "${getJobNoteText(job)}" | ${jobCustomerName ?? customerId}`);
          heldJobs.push({ job_id: jobId, customer: jobCustomerName ?? customerId ?? "—", note: getJobNoteText(job) });
          continue;
        }
        log(`Job ${jobId} - ASSIGNING despite note (manual override): "${getJobNoteText(job)}" | ${jobCustomerName ?? customerId}`, "WARN");
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
    if (blockingJobId != null && blockingJobId !== jobId) {
      const proxyDriverId = process.env.CARTRACK_REJECT_PROXY_DRIVER_ID ?? "";
      if (proxyDriverId) {
        const { status: assignStatus } = await assignJob(proxyDriverId, jobId, env);
        if (assignStatus === 200) {
          if (!rejectCookie) rejectCookie = await getFleetwebCookie();
          if (rejectCookie) {
            const ok = await rejectJobAsDuplicate(jobId, auth, rejectCookie);
            log(`Job ${jobId} - DUPLICATE of Job ${blockingJobId}: assigned→rejected ${ok ? "OK" : "FAILED"} | ${jobCustomerName ?? customerId}`, ok ? "WARN" : "ERROR");
          } else {
            log(`Job ${jobId} - DUPLICATE of Job ${blockingJobId}: assigned but no cookie to reject | ${jobCustomerName ?? customerId}`, "WARN");
          }
        } else {
          log(`Job ${jobId} - DUPLICATE of Job ${blockingJobId}: proxy assign failed, skipped | ${jobCustomerName ?? customerId}`, "WARN");
        }
      } else {
        log(`Job ${jobId} - DUPLICATE of Job ${blockingJobId}: no proxy driver configured, skipped | ${jobCustomerName ?? customerId}`, "WARN");
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
            log(`Job ${jobId} - PARKED until ${sendAtStr} (window: ${windowTimeFrom}) | ${jobCustomerName ?? customerId}`, "INFO");
          } else {
            log(`Job ${jobId} - Park failed: set=${setRes.status} assign=${assignRes.status} | ${jobCustomerName ?? customerId}`, "WARN");
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
          const driverId   = smartMapping.smart_driver_id[0];
          if (smartMapping.alt_drop_off_id) {
            const alt = await applyAltDropoff(jobId, smartMapping.alt_drop_off_id, job.stops ?? [], env, log);
            if (!alt.ok) continue;
          }
          try {
            // Assign via the update endpoint — it returns the driver, so the name comes
            // straight from Cartrack's response (no driver-list fetch needed).
            const { status: apiStatus, body, driverName: ctName } = await assignJobViaUpdate(jobId, driverId, env);
            if (apiStatus === 200) {
              const driverName = ctName || smartMapping.first_name_last_name || driverId;
              log(`Job ${jobId} | SMART(1) → ${driverName} | ${jobCustomerName ?? customerId}`, "OK");
            } else {
              log(`Job ${jobId} - SMART(1) failed: ${friendlyError(body)}`, "ERROR");
            }
          } catch (e) {
            log(`Job ${jobId} - SMART(1) error: ${e}`, "ERROR");
          }
          continue;
        }

        // ── Multi-driver: haversine → Goong rank, assign top ───────────────
        const pickupStop = job.stops.find((s) => s.stop_type_id === 1);
        if (!pickupStop?.latitude || !pickupStop?.longitude) {
          log(`Job ${jobId} - SMART skipped: pickup has no GPS | ${jobCustomerName ?? customerId}`, "ERROR");
          continue;
        }

        const candidates = allGpsDrivers.filter((d) =>
          smartMapping.smart_driver_id.includes(d.delivery_driver_id) &&
          phase1Coords.has(d.delivery_driver_id)
        );
        if (candidates.length === 0) {
          log(`Job ${jobId} - SMART skipped: 0/${smartMapping.smart_driver_id.length} configured drivers available (GPS or start_location) | ${jobCustomerName ?? customerId}`, "WARN");
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

        // Goong re-rank: reference stop → pickup
        const withGoong = await Promise.all(
          preRanked.map(async ({ d, hkm }) => {
            const info = smartRouteData[d.delivery_driver_id];
            const ref = info?.ref ?? null;
            const workload = info?.workload ?? 0;
            const tiebreakTs = ref?.tiebreakTs ?? null;
            const priority = ref ? ROUTE_STATE_PRIORITY[ref.label] : 0;
            const labelTag = ref ? `[${ref.label}] ` : "";
            const jobsDone = info?.jobsDone ?? 0;
            const name = `${d.first_name} ${d.last_name}`.trim();
            if (!ref) return { d, sortDist: hkm, priority, workload, tiebreakTs, jobsDone, name, distLabel: `${hkm}km GPS (load ${workload})` };
            // Distance reference points: primary ref; for "Next Stop" also the
            // last completed stop (driver may still be there). Take the min.
            const refPts: { lat: number; lon: number }[] = [{ lat: ref.lat, lon: ref.lon }];
            if (ref.altLat != null && ref.altLon != null) refPts.push({ lat: ref.altLat, lon: ref.altLon });
            const roads = await Promise.all(
              refPts.map((p) => goongDistanceKm(p.lat, p.lon, pickupStop.latitude!, pickupStop.longitude!))
            );
            const straights = refPts.map(
              (p) => Math.round(haversineKm(p.lat, p.lon, pickupStop.latitude!, pickupStop.longitude!) * 10) / 10
            );
            const effPerPoint = refPts.map((_, i) => roads[i] ?? straights[i]);
            const bestIdx = effPerPoint.reduce((bi, e, i) => (e < effPerPoint[bi] ? i : bi), 0);
            const roadKm = roads[bestIdx];
            const refHkm = straights[bestIdx];
            const sortDist = effPerPoint[bestIdx];
            const refName  = ref.customerName ? `@${ref.customerName} ` : "";
            const minTag   = refPts.length > 1 ? (bestIdx === 1 ? "via prev " : "via next ") : "";
            const distLabel = roadKm != null
              ? `${labelTag}${hkm}km GPS, ${minTag}${refName}→ ${roadKm}km road (load ${workload})`
              : `${labelTag}${hkm}km GPS, ${minTag}${refName}→ ${refHkm}km straight (load ${workload})`;
            return { d, sortDist, priority, workload, tiebreakTs, jobsDone, name, distLabel };
          })
        );
        withGoong.sort(rankingComparator);

        const top        = withGoong[0];
        const driverName = `${top.d.first_name} ${top.d.last_name}`.trim();
        const rankStr    = withGoong.slice(0, 3)
          .map((x, i) => `${i + 1}. ${x.d.first_name} ${x.d.last_name} (${x.distLabel})`)
          .join(" | ");
        if (smartMapping.alt_drop_off_id) {
          const alt = await applyAltDropoff(jobId, smartMapping.alt_drop_off_id, job.stops ?? [], env, log);
          if (!alt.ok) continue;
        }
        // Try candidates in ranked order; fall through to next if on-break/offline.
        let assigned = false;
        for (let attempt = 0; attempt < withGoong.length; attempt++) {
          const candidate = withGoong[attempt];
          const candidateName = `${candidate.d.first_name} ${candidate.d.last_name}`.trim();
          try {
            const { status: apiStatus, body } = await assignJob(candidate.d.delivery_driver_id, jobId, env);
            if (apiStatus === 200) {
              const tag = attempt > 0 ? `[#${attempt + 1}] ` : "";
              log(`Job ${jobId} | SMART ${tag}→ ${rankStr} | ${pickupStop.customer_name ?? customerId}`, "OK");
              assigned = true;
              break;
            } else if (isDriverUnavailable(body)) {
              log(`Job ${jobId} - SMART #${attempt + 1} ${candidateName}: on-break or offline, trying next`, "WARN");
            } else {
              log(`Job ${jobId} - SMART failed: ${friendlyError(body)}`, "ERROR");
              break;
            }
          } catch (e) {
            log(`Job ${jobId} - SMART error: ${e}`, "ERROR");
            break;
          }
        }
        if (!assigned) {
          const names = withGoong.map((x) => `${x.d.first_name} ${x.d.last_name}`.trim()).join(", ");
          log(`Job ${jobId} - SMART: all ${withGoong.length} candidate(s) on-break or unavailable (${names})`, "ERROR");
        }
        continue;
    }

    // ── Fixed driver path (original logic) ───────────────────────────────────
    const [drivers, status] = getDriversOnDuty(config, customerId, jobTime);

    if (status === "no_mapping") {
      log(
        `Job ${jobId} - NO MAPPING: ${jobCustomerName ?? customerId} not configured`,
        "ERROR"
      );
      continue;
    }

    if (status === "no_driver") {
      const shiftInfo = drivers
        .map((m) => `${fmtShift(m.shift_start)}–${fmtShift(m.shift_end)}`)
        .join(", ");
      const jt = vnHoursMinutes(jobTime);
      const hhmm = `${String(jt.hours).padStart(2, "0")}:${String(jt.minutes).padStart(2, "0")}`;
      log(
        `Job ${jobId} - NO DRIVER ON DUTY at ${hhmm} | ${jobCustomerName ?? customerId} | Shifts: ${shiftInfo}`,
        "ERROR"
      );
      continue;
    }

    if (status === "clash") {
      const driverList = drivers
        .map((m) => `${m.first_name_last_name || "?"} ${fmtShift(m.shift_start)}–${fmtShift(m.shift_end)}`)
        .join(", ");
      const jt = vnHoursMinutes(jobTime);
      const hhmm = `${String(jt.hours).padStart(2, "0")}:${String(jt.minutes).padStart(2, "0")}`;
      log(
        `Job ${jobId} - CLASH: ${drivers.length} drivers on duty at ${hhmm} | ${jobCustomerName ?? customerId} | ${driverList}`,
        "WARN"
      );
      continue;
    }

    // Exactly one driver on duty
    const mapping = drivers[0];
    const driverId = mapping.driver_id;
    if (!driverId) continue;

    // A broken sheet cell (#REF!, #N/A, …) would build a malformed assign URL
    // (/jobs/assign/#REF → Cartrack HTML 404). Catch it here with a clear,
    // visible message instead of a cryptic JSON-parse crash.
    if (!isValidDriverId(driverId)) {
      log(`Job ${jobId} - invalid driver_id "${driverId}" for ${jobCustomerName ?? customerId} — fix the Google Sheet`, "ERROR");
      continue;
    }

    // Alt drop-off: swap the dropoff customer before assigning. Keep the result so the
    // post-assign block can read the new dropoff name + coords without a getJobDetails.
    let altResult: AltDropoffResult | null = null;
    if (mapping.alt_drop_off_id) {
      altResult = await applyAltDropoff(jobId, mapping.alt_drop_off_id, job.stops ?? [], env, log);
      if (!altResult.ok) continue;
    }

    try {
      // Assign via the update endpoint — returns the driver, so the name comes from
      // Cartrack's response (no driver-list fetch). Single driver, no on-break fallback.
      const { status: apiStatus, body, driverName: ctName } = await assignJobViaUpdate(jobId, driverId, env);

      if (apiStatus === 200) {
        // Everything for the log + Zalo comes from data already in hand — no
        // getJobDetails. Pickup is unchanged → read off job.stops. For an alt-dropoff
        // job the dropoff was swapped, so its new name + coords come from the
        // applyAltDropoff result (it already fetched the alt customer record).
        // Name from Cartrack's assign response, then sheet, then UUID.
        const respDriverName = ctName || mapping.first_name_last_name || driverId;
        const pickupStop  = job.stops?.find((s) => s.stop_type_id === 1);
        const dropoffStop = job.stops?.find((s) => s.stop_type_id === 2);
        const pickupName  = pickupStop?.customer_name ?? jobCustomerName ?? "N/A";
        const pickupLat = pickupStop?.latitude;
        const pickupLon = pickupStop?.longitude;
        const dropoffName = altResult?.dropoffName ?? dropoffStop?.customer_name ?? "N/A";
        const dropoffLat = altResult ? altResult.dropoffLat : dropoffStop?.latitude;
        const dropoffLon = altResult ? altResult.dropoffLon : dropoffStop?.longitude;

        log(
          `Job ${jobId} | ${respDriverName} -> ${pickupName}`,
          "OK"
        );

        // Build route link
        const routeLink = buildGmapsRouteLink(pickupLat, pickupLon, dropoffLat, dropoffLon);

        // Zalo notification
        const { bot_token, chat_id } = mapping;
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

          const sent = await sendZaloMessage(
            bot_token,
            chat_id,
            lines.join("\n")
          );
          if (sent) log("Zalo notification sent");
        }

        // Route optimisation — pilot drivers only
        const pilotDrivers = (process.env.ROUTE_OPTIMIZE_PILOT ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (pilotDrivers.includes(driverId)) {
          const ok = await optimizeDriverRoute(driverId, vnDate());
          log(`Route optimise for ${driverId}: ${ok ? "triggered" : "skipped (no cookie or failed)"}`, ok ? "INFO" : "WARN");
        }
      } else {
        log(`Job ${jobId} failed: ${friendlyError(body)}`, "ERROR");
      }
    } catch (e) {
      log(`Job ${jobId} error: ${e}`, "ERROR");
    }
  }

  if (!onlyJobIds) {
    await Promise.all([
      setHeldJobs(heldJobs),
      setPickupWarnings(computePickupWarnings(assignedJobsToday, today)),
    ]);
  }
  return logs;
  } finally {
    // Both follow-up steps need today's status 2/4/5 job lists. Fetch each list
    // ONCE and share it — previously via-legs and return-trips each fetched their
    // own, so status 4 was pulled 3×/cycle and status 5 2×/cycle. If the shared
    // prefetch fails, fall through to each step self-fetching (pass undefined).
    const followToday = vnDate();
    let shared: { s2: Job[]; s4: Job[]; s5: Job[] } | undefined;
    try {
      const [s2, s4, s5] = await Promise.all([
        getJobsByStatusAndDate(2, followToday, env),
        getJobsByStatusAndDate(4, followToday, env),
        getJobsByStatusAndDate(5, followToday, env),
      ]);
      shared = { s2, s4, s5 };
    } catch (e) {
      log(`Follow-up prefetch failed, each step will self-fetch: ${e}`, "WARN");
    }

    // Forward via-legs first (driver is en route toward the via PSC — more time-sensitive).
    // Pass the shared prefetch so neither step re-fetches the status 2/4/5 lists; falls
    // back to self-fetch when `shared` is undefined (prefetch above failed).
    try {
      await detectAndCreateViaLegs(env, log, shared && { s4: shared.s4, s5: shared.s5 });
    } catch (e) {
      log(`Via-leg hook failed: ${e}`, "ERROR");
    }
    try {
      await detectAndCreateReturnTrips(config, env, log, shared);
    } catch (e) {
      log(`Return-trip hook failed: ${e}`, "ERROR");
    }
  }
}

function fmtShift(t: { hours: number; minutes: number } | null): string {
  if (!t) return "??";
  return `${String(t.hours).padStart(2, "0")}:${String(t.minutes).padStart(2, "0")}`;
}
