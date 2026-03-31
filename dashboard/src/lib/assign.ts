import type { Config, Job, LogEntry, LogLevel, Mapping } from "./types";
import { getUnassignedJobs, assignJob, getJobDetails, getCustomerById, updateJobStops, optimizeDriverRoute, type Env } from "./cartrack";
import { sendZaloMessage } from "./zalo";

const TZ = "Asia/Ho_Chi_Minh";

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
  if (startMin > endMin) {
    return jobMinutes >= startMin || jobMinutes <= endMin;
  }
  return jobMinutes >= startMin && jobMinutes <= endMin;
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

export async function autoAssignCycle(config: Config, env: Env = "prod"): Promise<LogEntry[]> {
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

    let jobTime: Date;
    try {
      jobTime = new Date((job.create_ts ?? "").replace(" ", "T") + "+07:00");
      if (isNaN(jobTime.getTime())) jobTime = new Date();
    } catch {
      jobTime = new Date();
    }

    const [drivers, status] = getDriversOnDuty(config, customerId, jobTime);

    if (status === "no_mapping") {
      log(
        `Job ${jobId} - NO MAPPING: customer ${customerId} not configured`,
        "ERROR"
      );
      continue;
    }

    if (status === "no_driver") {
      const shiftInfo = drivers
        .map(
          (m) =>
            `${m.driver_id} (${fmtShift(m.shift_start)}-${fmtShift(m.shift_end)})`
        )
        .join(", ");
      const jt = saigonHoursMinutes(jobTime);
      const hhmm = `${String(jt.hours).padStart(2, "0")}:${String(jt.minutes).padStart(2, "0")}`;
      log(
        `Job ${jobId} - NO DRIVER ON DUTY at ${hhmm} | Configured: ${shiftInfo}`,
        "ERROR"
      );
      continue;
    }

    if (status === "clash") {
      const driverList = drivers
        .map(
          (m) =>
            `${m.driver_id} (${fmtShift(m.shift_start)}-${fmtShift(m.shift_end)})`
        )
        .join(", ");
      const jt = saigonHoursMinutes(jobTime);
      const hhmm = `${String(jt.hours).padStart(2, "0")}:${String(jt.minutes).padStart(2, "0")}`;
      log(
        `Job ${jobId} - CLASH: ${drivers.length} drivers on duty at ${hhmm}: ${driverList}`,
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
