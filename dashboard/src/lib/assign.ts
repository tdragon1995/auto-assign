import type { Config, Driver, Job, LogEntry, LogLevel, Mapping } from "./types";
import { getDrivers, getUnassignedJobs, assignJob, getJobDetails, getCustomerById, updateJobStops, optimizeDriverRoute, getFleetwebCookie, type Env } from "./cartrack";
import { sendZaloMessage } from "./zalo";
import { PSC_TINH_LABEL } from "./psc-config";
import {
  vnDate,
  vnTimestamp,
  vnHoursMinutes,
  vnMinutesSinceMidnight,
  vnDayWindow,
  parseVnTimestamp,
} from "./time";

const JSONRPC_URL = "https://fleetweb-vn.cartrack.com/jsonrpc/index.php";
const GOONG_API   = "https://rsapi.goong.io/v2/distancematrix";

const REST_BASE = "https://fleetapi-vn.cartrack.com/rest/delivery";

const DUPLICATE_REJECT_REASON =
  "Yêu cầu liền kề vẫn đang được thực hiện, quý khách vui lòng đợi thêm giây lát hoặc liên hệ Diag nếu cần được hỗ trợ!";

// Jobs carrying any of these labels are exempt from duplicate detection.
// PSC tỉnh jobs are multi-leg provincial routes — the same pickup→dropoff pair
// is expected to repeat across different legs and should never be blocked.
const DUPLICATE_EXEMPT_LABELS = [PSC_TINH_LABEL];

// ── Duplicate-check helpers ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAssignedJobsToday(vnDate: string, auth: string): Promise<any[]> {
  const params = new URLSearchParams({
    "filter[job_status_id]": "4",
    "filter[create_ts_from]": `${vnDate} 00:00:00`,
    "filter[create_ts_to]":   `${vnDate} 23:59:59`,
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

// Returns pickup customer_ids that have an assigned job today with an active pickup
// Returns Map<"pickup_id:dropoff_id", blocking_job_id> for assigned jobs today
// where the pickup stop is not yet completed/rejected and window is not >1h away.
async function buildActiveRouteMap(vnDate: string, auth: string): Promise<Map<string, number>> {
  const jobs = await fetchAssignedJobsToday(vnDate, auth);
  const result = new Map<string, number>();

  // Current VN time in minutes-since-midnight
  const nowMinutes = vnMinutesSinceMidnight();

  for (const job of jobs) {
    if (job.job_status_id === 7 || job.job_status_id === 3) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stops = (job.stops ?? []) as any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickup  = stops.find((s: any) => s.stop_type_id === 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dropoff = stops.find((s: any) => s.stop_type_id === 2);
    if (!pickup?.customer_id || !dropoff?.customer_id) continue;
    if (pickup.stop_status_id === 4 || pickup.stop_status_id === 5) continue;

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

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

async function goongDistanceKm(
  fromLat: number, fromLon: number, toLat: number, toLon: number
): Promise<number | null> {
  const apiKey = process.env.GOONG_API_KEY ?? "";
  if (!apiKey) return null;
  try {
    const url = `${GOONG_API}?origins=${fromLat},${fromLon}&destinations=${toLat},${toLon}&vehicle=bike&api_key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const el = data.rows?.[0]?.elements?.[0];
    if (!el || el.status !== "OK") return null;
    return Math.round(el.distance.value / 100) / 10;
  } catch {
    return null;
  }
}

type RefStop = { lat: number; lon: number; customerName: string | null };
type RefLabel = "Arrived" | "En Route" | "Next Stop" | "First Stop" | "Start Location";
type DriverRouteInfo = { ref: RefStop | null; label: RefLabel | null; workload: number; lastCompletedTs: string | null; jobsDone: number };

const GPS_FRESH_MS = 15 * 60 * 1000;

async function fetchSmartRouteData(
  dateVn: string, auth: string, cookie: string
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
    const routes: {
      routeId: string;
      orderedStops?: { stopStatusId: number; latitude: number; longitude: number; customerName?: string; activityCompletedTs?: string }[];
    }[] = data.result?.routes ?? [];

    const result: Record<string, DriverRouteInfo> = {};
    for (const route of routes) {
      const driverId = route.routeId.replace(/^driver_/, "");
      const stops = route.orderedStops ?? [];
      // Reference stop logic mirrors smart-assign: Arrived > En Route > Next pending after last completed > First pending (all pending)
      const validStops = stops.filter((s) => s.latitude && s.longitude);
      const arrivedStop = validStops.find((s) => s.stopStatusId === 3) ?? null;
      const enRouteStop = validStops.find((s) => s.stopStatusId === 2) ?? null;

      let ref: RefStop | null = null;
      let label: RefLabel | null = null;
      const toLoc = (s: { latitude: number; longitude: number; customerName?: string }): RefStop =>
        ({ lat: s.latitude, lon: s.longitude, customerName: s.customerName ?? null });

      if (arrivedStop) {
        ref = toLoc(arrivedStop); label = "Arrived";
      } else if (enRouteStop) {
        ref = toLoc(enRouteStop); label = "En Route";
      } else if (validStops.length > 0) {
        let lastCompletedIdx = -1;
        for (let i = validStops.length - 1; i >= 0; i--) {
          if (validStops[i].stopStatusId === 4) { lastCompletedIdx = i; break; }
        }
        if (lastCompletedIdx === -1) {
          if (validStops.every((s) => s.stopStatusId === 1)) {
            ref = toLoc(validStops[0]); label = "First Stop";
          }
        } else {
          const nextPending = validStops.slice(lastCompletedIdx + 1).find((s) => s.stopStatusId === 1);
          if (nextPending) { ref = toLoc(nextPending); label = "Next Stop"; }
        }
      }

      let lastCompletedTs: string | null = null;
      let jobsDone = 0;
      for (const stop of stops) {
        if (stop.stopStatusId !== 4) continue;
        jobsDone++;
        if (stop.activityCompletedTs && (!lastCompletedTs || stop.activityCompletedTs > lastCompletedTs)) {
          lastCompletedTs = stop.activityCompletedTs;
        }
      }
      result[driverId] = { ref, label, workload: stops.length, lastCompletedTs, jobsDone };
    }
    return result;
  } catch {
    return {};
  }
}

function makeLog(msg: string, level: LogLevel = "INFO"): LogEntry {
  return { ts: vnTimestamp(), level, msg };
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

export function isJobRecent(job: Job, maxAgeMinutes: number): boolean {
  const jobTime = parseVnTimestamp(job.create_ts);
  if (isNaN(jobTime.getTime())) return false;

  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  return jobTime >= cutoff;
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

export function getCustomerIdFromJob(job: Job): string | null {
  for (const stop of job.stops ?? []) {
    if (stop.stop_type_id === 1) return stop.customer_id ?? null;
  }
  return null;
}

function getCustomerNameFromJob(job: Job): string | null {
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
async function applyAltDropoff(
  jobId: number,
  altDropOffId: string,
  env: Env,
  log: (msg: string, level?: LogLevel) => void
): Promise<boolean> {
  let altCustomerName = altDropOffId;
  try {
    const customerData = await getCustomerById(altDropOffId, env);
    if (customerData?.data) {
      const c = customerData.data;
      altCustomerName = c.customer_name || c.name || altCustomerName;
    }

    const details = await getJobDetails(jobId, env);
    const rawStops = (details.data?.stops ?? []) as {
      stop_id?: number;
      stop_type_id?: number;
      customer_id?: string;
      customer_name?: string;
    }[];

    const updatedStops = rawStops
      .filter((s) => s.stop_id && s.stop_type_id && s.customer_id)
      .map((s) => ({
        stop_id: s.stop_id!,
        stop_type_id: s.stop_type_id!,
        customer_id: s.stop_type_id === 2 ? altDropOffId : s.customer_id!,
        customer_name: s.stop_type_id === 2 ? altCustomerName : s.customer_name,
      }));

    if (updatedStops.length >= 2) {
      const putRes = await updateJobStops(jobId, updatedStops, env);
      if (putRes.ok) {
        log(`Job ${jobId} - dropoff swapped to ${altCustomerName}`, "INFO");
      } else {
        log(`Job ${jobId} - dropoff swap failed (${putRes.status})`, "ERROR");
        return false;
      }
    }
    return true;
  } catch (e) {
    log(`Job ${jobId} - dropoff swap error: ${e}`, "ERROR");
    return false;
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

export async function autoAssignCycle(config: Config, env: Env = "prod", skipSmart = false): Promise<LogEntry[]> {
  const logs: LogEntry[] = [];
  const log = (msg: string, level: LogLevel = "INFO") => {
    logs.push(makeLog(msg, level));
  };

  // Fetch unassigned jobs
  let jobs: Job[];
  try {
    const data = await getUnassignedJobs(1, 50, env);
    jobs = data.data ?? [];
  } catch (e) {
    log(`Error fetching jobs: ${e}`, "ERROR");
    return logs;
  }

  if (jobs.length === 0) {
    log("No unassigned jobs");
    return logs;
  }

  // Filter recent
  const maxAge = config.job_max_age_minutes;
  jobs = jobs.filter((j) => isJobRecent(j, maxAge));

  if (jobs.length === 0) {
    log(`No jobs within last ${maxAge} min`);
    return logs;
  }

  log(`Found ${jobs.length} recent job(s)`);

  // ── Duplicate-check setup (1 extra GET /jobs?status=4 per cycle) ──────────
  const today = vnDate();
  const authSuffix = env === "uat" ? "_UAT" : "";
  const auth = process.env[`CARTRACK_AUTH${authSuffix}`] ?? "";
  const activeRouteMap = await buildActiveRouteMap(today, auth);
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
    if (cookie && auth) {
      smartRouteData = await fetchSmartRouteData(vnDate(), auth, cookie);
    }

    // GPS-fresh override: if driver hasn't started (First Stop) but GPS is fresh, rely on GPS instead
    const nowMs = Date.now();
    for (const d of allGpsDrivers) {
      const info = smartRouteData[d.delivery_driver_id];
      if (info?.label !== "First Stop" || !d.last_login_ts) continue;
      const loginMs = new Date(d.last_login_ts).getTime();
      if (!Number.isFinite(loginMs)) continue;
      if (nowMs - loginMs < GPS_FRESH_MS) {
        smartRouteData[d.delivery_driver_id] = { ...info, ref: null, label: null };
      }
    }

    // ── Fetch start_location coords for drivers who need them ──
    // Two reasons: (1) no GPS → Phase 1 fallback, (2) no route today → reference-stop fallback.
    const startLocIdsNeeded = new Set<string>();
    for (const d of allGpsDrivers) {
      if (!d.start_location_customer_id) continue;
      const info = smartRouteData[d.delivery_driver_id];
      const noGps = d.latitude == null || d.longitude == null;
      const needsRefFallback = !info?.ref && (!info || info.workload === 0);
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

    // Reference-stop fallback: drivers with NO route today → use start_location as ref
    for (const d of allGpsDrivers) {
      if (!d.start_location_customer_id) continue;
      const info = smartRouteData[d.delivery_driver_id];
      if (info?.ref) continue;
      if (info && info.workload > 0) continue;
      const coords = startLocCoords.get(d.start_location_customer_id);
      if (!coords) continue;
      smartRouteData[d.delivery_driver_id] = {
        ref: { lat: coords.lat, lon: coords.lon, customerName: coords.name },
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

  for (const job of jobs) {
    const jobId = job.job_id;
    const customerId = getCustomerIdFromJob(job);
    const jobCustomerName = getCustomerNameFromJob(job);

    if (jobHasNotes(job)) {
      log(`Job ${jobId} - SKIPPED: stop has note`);
      continue;
    }

    if (!customerId) {
      log(`Job ${jobId} - No pickup stop found`, "ERROR");
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

    if (skipSmart && smartCustomerIds.has(customerId)) {
      continue;
    }

    let jobTime: Date;
    try {
      jobTime = parseVnTimestamp(job.create_ts);
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
          const gpsDriver  = allGpsDrivers.find((d) => d.delivery_driver_id === driverId);
          const driverName = gpsDriver
            ? `${gpsDriver.first_name} ${gpsDriver.last_name}`.trim()
            : (smartMapping.first_name_last_name || driverId);
          if (smartMapping.alt_drop_off_id) {
            const ok = await applyAltDropoff(jobId, smartMapping.alt_drop_off_id, env, log);
            if (!ok) continue;
          }
          try {
            const { status: apiStatus, body } = await assignJob(driverId, jobId, env);
            if (apiStatus === 200) {
              log(`Job ${jobId} | SMART(1) → ${driverName} | ${jobCustomerName ?? customerId}`, "OK");
            } else {
              log(`Job ${jobId} - SMART(1) failed: ${body?.message ?? JSON.stringify(body)}`, "ERROR");
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
            const lastCompletedTs = info?.lastCompletedTs ?? null;
            const jobsDone = info?.jobsDone ?? 0;
            const name = `${d.first_name} ${d.last_name}`.trim();
            if (!ref) return { d, sortDist: hkm, workload, lastCompletedTs, jobsDone, name, distLabel: `${hkm}km GPS (load ${workload})` };
            const roadKm = await goongDistanceKm(ref.lat, ref.lon, pickupStop.latitude!, pickupStop.longitude!);
            const refHkm = Math.round(haversineKm(ref.lat, ref.lon, pickupStop.latitude!, pickupStop.longitude!) * 10) / 10;
            const sortDist = roadKm ?? refHkm;
            const refName  = ref.customerName ? `@${ref.customerName} ` : "";
            const distLabel = roadKm != null
              ? `${hkm}km GPS, ${refName}→ ${roadKm}km road (load ${workload})`
              : `${hkm}km GPS, ${refName}→ ${refHkm}km straight (load ${workload})`;
            return { d, sortDist, workload, lastCompletedTs, jobsDone, name, distLabel };
          })
        );
        // Tiebreakers: distance asc → lastCompletedTs asc (null = most idle) → jobsDone asc → name asc
        withGoong.sort((a, b) => {
          if (a.sortDist !== b.sortDist) return a.sortDist - b.sortDist;
          const aTs = a.lastCompletedTs ?? "";
          const bTs = b.lastCompletedTs ?? "";
          if (aTs !== bTs) return aTs.localeCompare(bTs);
          if (a.jobsDone !== b.jobsDone) return a.jobsDone - b.jobsDone;
          return a.name.localeCompare(b.name);
        });

        const top        = withGoong[0];
        const driverName = `${top.d.first_name} ${top.d.last_name}`.trim();
        const rankStr    = withGoong.slice(0, 3)
          .map((x, i) => `${i + 1}. ${x.d.first_name} ${x.d.last_name} (${x.distLabel})`)
          .join(" | ");
        if (smartMapping.alt_drop_off_id) {
          const ok = await applyAltDropoff(jobId, smartMapping.alt_drop_off_id, env, log);
          if (!ok) continue;
        }
        try {
          const { status: apiStatus, body } = await assignJob(top.d.delivery_driver_id, jobId, env);
          if (apiStatus === 200) {
            log(`Job ${jobId} | SMART → ${rankStr} | ${pickupStop.customer_name ?? customerId}`, "OK");
          } else {
            log(`Job ${jobId} - SMART failed: ${body?.message ?? JSON.stringify(body)}`, "ERROR");
          }
        } catch (e) {
          log(`Job ${jobId} - SMART error: ${e}`, "ERROR");
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
        .map((m) => `${m.first_name_last_name || m.driver_id} (${fmtShift(m.shift_start)}–${fmtShift(m.shift_end)})`)
        .join(", ");
      const jt = vnHoursMinutes(jobTime);
      const hhmm = `${String(jt.hours).padStart(2, "0")}:${String(jt.minutes).padStart(2, "0")}`;
      log(
        `Job ${jobId} - NO DRIVER ON DUTY at ${hhmm} | ${jobCustomerName ?? customerId} | Configured: ${shiftInfo}`,
        "ERROR"
      );
      continue;
    }

    if (status === "clash") {
      const driverList = drivers
        .map((m) => `${m.first_name_last_name || m.driver_id} (${fmtShift(m.shift_start)}–${fmtShift(m.shift_end)})`)
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

    // Alt drop-off: swap the dropoff customer before assigning
    if (mapping.alt_drop_off_id) {
      const ok = await applyAltDropoff(jobId, mapping.alt_drop_off_id, env, log);
      if (!ok) continue;
    }

    try {
      const { status: apiStatus, body } = await assignJob(driverId, jobId, env);

      if (apiStatus === 200) {
        const details = await getJobDetails(jobId, env);
        const data = details.data ?? {};
        const stops = data.stops ?? [];

        const pickupName =
          stops[0]?.customer_name ?? "N/A";
        const dropoffName =
          stops[1]?.customer_name ?? "N/A";

        const driverData = data.driver ?? {};
        const respDriverName =
          `${driverData.first_name ?? ""} ${driverData.last_name ?? ""}`.trim() ||
          "N/A";

        log(
          `Job ${jobId} | ${respDriverName} -> ${pickupName}`,
          "OK"
        );

        // Build route link
        let routeLink: string | null = null;
        if (stops.length >= 2) {
          routeLink = buildGmapsRouteLink(
            stops[0]?.latitude,
            stops[0]?.longitude,
            stops[1]?.latitude,
            stops[1]?.longitude
          );
        }

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
        const errorMsg = body?.message ?? JSON.stringify(body);
        log(`Job ${jobId} failed: ${errorMsg}`, "ERROR");
      }
    } catch (e) {
      log(`Job ${jobId} error: ${e}`, "ERROR");
    }
  }

  return logs;
}

function fmtShift(t: { hours: number; minutes: number } | null): string {
  if (!t) return "??";
  return `${String(t.hours).padStart(2, "0")}:${String(t.minutes).padStart(2, "0")}`;
}
