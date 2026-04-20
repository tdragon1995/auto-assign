import type { Config, Driver, Job, LogEntry, LogLevel, Mapping } from "./types";
import { getDrivers, getUnassignedJobs, assignJob, getJobDetails, getCustomerById, updateJobStops, optimizeDriverRoute, getFleetwebCookie, type Env } from "./cartrack";
import { sendZaloMessage } from "./zalo";

const TZ = "Asia/Ho_Chi_Minh";
const JSONRPC_URL = "https://fleetweb-vn.cartrack.com/jsonrpc/index.php";
const GOONG_API   = "https://rsapi.goong.io/v2/distancematrix";

const REST_BASE = "https://fleetapi-vn.cartrack.com/rest/delivery";

const DUPLICATE_REJECT_REASON =
  "Yêu cần gần nhất vẫn đang được thực hiện, quý khách vui lòng đợi thêm giây lát hoặc liên hệ Diag nếu cần được hỡ trợ!";

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
  const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const nowMinutes = vnNow.getUTCHours() * 60 + vnNow.getUTCMinutes();

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
type DriverRouteInfo = { ref: RefStop | null; workload: number };

async function fetchSmartRouteData(
  dateVn: string, auth: string, cookie: string
): Promise<Record<string, DriverRouteInfo>> {
  try {
    const res = await fetch(JSONRPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth, Cookie: cookie },
      body: JSON.stringify({
        version: "2.0", method: "delivery_timeline_route_list", id: 1,
        params: { data: { scheduleType: "scheduled", filter: {
          from: `${dateVn}T00:00:00+07:00`,
          to:   `${dateVn}T23:59:59+07:00`,
        }}},
      }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const routes: {
      routeId: string;
      orderedStops?: { stopStatusId: number; latitude: number; longitude: number; customerName?: string }[];
    }[] = data.result?.routes ?? [];

    const result: Record<string, DriverRouteInfo> = {};
    for (const route of routes) {
      const driverId = route.routeId.replace(/^driver_/, "");
      const stops = route.orderedStops ?? [];
      let arrived: RefStop | null = null;
      let enRoute: RefStop | null = null;
      let lastCompleted: RefStop | null = null;
      for (const stop of stops) {
        if (!stop.latitude || !stop.longitude) continue;
        const loc: RefStop = { lat: stop.latitude, lon: stop.longitude, customerName: stop.customerName ?? null };
        if (stop.stopStatusId === 3) arrived       = loc;
        if (stop.stopStatusId === 2) enRoute       = loc;
        if (stop.stopStatusId === 4) lastCompleted = loc;
      }
      result[driverId] = {
        ref: arrived ?? enRoute ?? lastCompleted ?? null,
        workload: stops.length,
      };
    }
    return result;
  } catch {
    return {};
  }
}

/** Current time formatted in Saigon timezone */
function now(): string {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** Get hours and minutes in Saigon timezone for a given Date */
function saigonHoursMinutes(d: Date): { hours: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(d);
  const hours = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minutes = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return { hours, minutes };
}

function makeLog(msg: string, level: LogLevel = "INFO"): LogEntry {
  return { ts: now(), level, msg };
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

  const { hours, minutes } = saigonHoursMinutes(jobTime);
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
  const createTs = job.create_ts;
  if (!createTs) return false;

  // Cartrack timestamps are Saigon local time (UTC+7), no TZ suffix
  const jobTime = new Date(createTs.replace(" ", "T") + "+07:00");
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
  const vnDate = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date()).slice(0, 10);
  const authSuffix = env === "uat" ? "_UAT" : "";
  const auth = process.env[`CARTRACK_AUTH${authSuffix}`] ?? "";
  const activeRouteMap = await buildActiveRouteMap(vnDate, auth);
  let rejectCookie: string | null = null;

  // ── Pre-fetch GPS + route data only if a current job needs smart-assign ──────
  const smartCustomerIds = new Set(
    config.mappings.filter((m) => m.smart_driver_id.length > 0).map((m) => m.customer_id)
  );
  const hasSmartJobs = !skipSmart && jobs.some((j) => {
    const cid = getCustomerIdFromJob(j);
    return cid !== null && smartCustomerIds.has(cid);
  });

  let allGpsDrivers: Driver[] = [];
  let smartRouteData: Record<string, DriverRouteInfo> = {};

  if (hasSmartJobs) {
    const auth   = process.env.CARTRACK_AUTH ?? "";
    const [fetchedDrivers, cookie] = await Promise.all([getDrivers(env), getFleetwebCookie()]);
    allGpsDrivers = fetchedDrivers.filter((d) => d.latitude != null && d.longitude != null);
    if (cookie && auth) {
      const vnDate = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date()).slice(0, 10);
      smartRouteData = await fetchSmartRouteData(vnDate, auth, cookie);
    }

    // Fallback: drivers with no route data today → use start_location_customer_id as ref
    const noRefDrivers = allGpsDrivers.filter(
      (d) => !smartRouteData[d.delivery_driver_id]?.ref && d.start_location_customer_id
    );
    if (noRefDrivers.length > 0) {
      await Promise.all(noRefDrivers.map(async (d) => {
        const customerData = await getCustomerById(d.start_location_customer_id!, env);
        const c = customerData?.data;
        if (c?.latitude != null && c?.longitude != null) {
          smartRouteData[d.delivery_driver_id] = {
            ref: { lat: c.latitude, lon: c.longitude, customerName: c.customer_name ?? null },
            workload: smartRouteData[d.delivery_driver_id]?.workload ?? 0,
          };
        }
      }));
    }

    log(`Smart-assign ready: ${allGpsDrivers.length} drivers with GPS`);
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
    const isPscTinh = jobLabels.includes("🛵 Vận chuyển mẫu tỉnh");
    const routeKey = dropoffId && !isPscTinh ? `${customerId}:${dropoffId}` : null;
    const blockingJobId = routeKey ? activeRouteMap.get(routeKey) : undefined;
    if (blockingJobId != null && blockingJobId !== jobId) {
      const proxyDriverId = process.env.CARTRACK_REJECT_PROXY_DRIVER_ID ?? "";
      if (proxyDriverId) {
        const { status: assignStatus } = await assignJob(proxyDriverId, jobId, "Reject Proxy", env);
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
      jobTime = new Date((job.create_ts ?? "").replace(" ", "T") + "+07:00");
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
          try {
            const { status: apiStatus, body } = await assignJob(driverId, jobId, driverName, env);
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
          smartMapping.smart_driver_id.includes(d.delivery_driver_id)
        );
        if (candidates.length === 0) {
          log(`Job ${jobId} - SMART skipped: 0/${smartMapping.smart_driver_id.length} configured drivers have GPS | ${jobCustomerName ?? customerId}`, "WARN");
          continue;
        }

        // Haversine pre-rank
        const preRanked = candidates
          .map((d) => ({
            d,
            hkm: Math.round(haversineKm(pickupStop.latitude!, pickupStop.longitude!, d.latitude!, d.longitude!) * 10) / 10,
          }))
          .sort((a, b) => a.hkm - b.hkm);

        // Goong re-rank: reference stop → pickup
        const withGoong = await Promise.all(
          preRanked.map(async ({ d, hkm }) => {
            const info = smartRouteData[d.delivery_driver_id];
            const ref = info?.ref ?? null;
            const workload = info?.workload ?? 0;
            const name = `${d.first_name} ${d.last_name}`.trim();
            if (!ref) return { d, sortDist: hkm, workload, name, distLabel: `${hkm}km GPS (load ${workload})` };
            const roadKm = await goongDistanceKm(ref.lat, ref.lon, pickupStop.latitude!, pickupStop.longitude!);
            const refHkm = Math.round(haversineKm(ref.lat, ref.lon, pickupStop.latitude!, pickupStop.longitude!) * 10) / 10;
            const sortDist = roadKm ?? refHkm;
            const refName  = ref.customerName ? `@${ref.customerName} ` : "";
            const distLabel = roadKm != null
              ? `${hkm}km GPS, ${refName}→ ${roadKm}km road (load ${workload})`
              : `${hkm}km GPS, ${refName}→ ${refHkm}km straight (load ${workload})`;
            return { d, sortDist, workload, name, distLabel };
          })
        );
        // Tiebreakers: distance asc → workload asc → name asc
        withGoong.sort((a, b) => {
          if (a.sortDist !== b.sortDist) return a.sortDist - b.sortDist;
          if (a.workload !== b.workload) return a.workload - b.workload;
          return a.name.localeCompare(b.name);
        });

        const top        = withGoong[0];
        const driverName = `${top.d.first_name} ${top.d.last_name}`.trim();
        const rankStr    = withGoong.slice(0, 3)
          .map((x, i) => `${i + 1}. ${x.d.first_name} ${x.d.last_name} (${x.distLabel})`)
          .join(" | ");
        try {
          const { status: apiStatus, body } = await assignJob(top.d.delivery_driver_id, jobId, driverName, env);
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
      const jt = saigonHoursMinutes(jobTime);
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
      const jt = saigonHoursMinutes(jobTime);
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
      try {
        // Fetch alt customer name
        let altCustomerName = mapping.alt_drop_off_id;
        const customerData = await getCustomerById(mapping.alt_drop_off_id, env);
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
            customer_id:
              s.stop_type_id === 2 ? mapping.alt_drop_off_id : s.customer_id!,
            customer_name:
              s.stop_type_id === 2 ? altCustomerName : s.customer_name,
          }));

        if (updatedStops.length >= 2) {
          const putRes = await updateJobStops(jobId, updatedStops, env);
          if (putRes.ok) {
            log(`Job ${jobId} - dropoff swapped to ${altCustomerName}`, "INFO");
          } else {
            log(`Job ${jobId} - dropoff swap failed (${putRes.status})`, "ERROR");
            continue;
          }
        }
      } catch (e) {
        log(`Job ${jobId} - dropoff swap error: ${e}`, "ERROR");
        continue;
      }
    }

    try {
      const { status: apiStatus, body } = await assignJob(
        driverId,
        jobId,
        mapping.first_name_last_name || undefined,
        env
      );

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
          const vnDate = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ })
            .format(new Date())
            .slice(0, 10);
          const ok = await optimizeDriverRoute(driverId, vnDate);
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
