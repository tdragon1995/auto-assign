import { getJobsByDate, parkOnProxy, PROXY_DRIVER_ID, unassignJob, updateJobScheduledDeliveryTs, type Env } from "./cartrack";
import { addDays, parseVnTimestamp, vnDate, vnMinutesSinceMidnight, vnTimestamp } from "./time";
import type { Job, LogLevel } from "./types";

const LEAD_MS = 60 * 60 * 1000;

/** Same parking order as dashboard Hẹn giờ: park, then restore the delivery date. */
export async function parkScheduledJob(jobId: number, scheduledAt: string, env: Env, now = new Date()) {
  const appointment = parseVnTimestamp(scheduledAt).getTime();
  if (!Number.isFinite(appointment)) throw new Error("Invalid appointment time");
  const futureDay = scheduledAt.slice(0, 10) > vnDate(now);
  if (!futureDay && appointment - now.getTime() <= LEAD_MS) return false;

  const sendAt = vnTimestamp(new Date(appointment - LEAD_MS));
  const parked = await parkOnProxy(jobId, sendAt, env);
  if (!parked.ok) throw new Error(`park ${parked.detail}`);
  // Proxy assignment can reset a future date to today. This must be the last write.
  if (futureDay) {
    const dated = await updateJobScheduledDeliveryTs(jobId, scheduledAt, env);
    if (!dated.ok) throw new Error(`reschedule ${dated.status}`);
  }
  return true;
}

/** Today's normal fetch cannot see tomorrow's 00:xx appointments. Read those only
 * during the final hour, and include due unassigned jobs every cycle so a failed
 * driver lookup still retries before midnight. Never take a job from a real driver. */
export async function getDueTomorrowJobs(
  env: Env,
  log: (msg: string, level?: LogLevel) => void,
  now = new Date(),
): Promise<Job[]> {
  if (vnMinutesSinceMidnight(now) % 1440 < 23 * 60) return [];
  const tomorrow = addDays(vnDate(now), 1);
  const jobs = await getJobsByDate(tomorrow, env);
  const due: Job[] = [];
  for (const job of jobs) {
    if (![2, 4].includes(job.job_status_id ?? 0)) continue;
    if (job.delivery_driver_id && job.delivery_driver_id !== PROXY_DRIVER_ID) continue;
    const pickup = job.stops.find((s) => s.stop_type_id === 1);
    if (pickup?.stop_status_id !== 1) continue;
    const time = pickup.delivery_windows?.[0]?.time_from?.slice(0, 8);
    if (!time || !/^\d{2}:\d{2}:\d{2}$/.test(time)) continue;
    const appointment = parseVnTimestamp(`${tomorrow} ${time}`).getTime();
    if (!Number.isFinite(appointment) || appointment > now.getTime() + LEAD_MS) continue;
    if (job.delivery_driver_id === PROXY_DRIVER_ID) {
      // Respect an explicitly later release time (e.g. a supervisor's override).
      const releaseAt = job.send_to_driver_at;
      const releaseMs = releaseAt
        ? new Date(/[Zz]$|[+-]\d{2}:?\d{2}$/.test(releaseAt) ? releaseAt.replace(" ", "T") : `${releaseAt.replace(" ", "T")}+07:00`).getTime()
        : appointment - LEAD_MS;
      if (!Number.isFinite(releaseMs) || releaseMs > now.getTime()) continue;
      const released = await unassignJob(job.job_id, env, PROXY_DRIVER_ID);
      if (!released.ok) {
        log(`Job ${job.job_id} - Release failed (HTTP ${released.status}) for tomorrow's appointment`, "WARN");
        continue;
      }
      log(`Job ${job.job_id} - RELEASED from proxy driver for ${tomorrow} ${time}`, "INFO");
    }
    // The successful unassign is authoritative even while the list's driver field lags.
    due.push({ ...job, job_status_id: 2, delivery_driver_id: null, driver: null });
  }
  return due;
}
