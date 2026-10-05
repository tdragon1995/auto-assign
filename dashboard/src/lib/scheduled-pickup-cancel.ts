import { cancelJobFromTimeline, getJobDetails, getJobsByDate, PROXY_DRIVER_ID } from "./cartrack";
import { SCHEDULE_JOB_LABEL } from "./schedule-job";
import { vnDate } from "./time";
import type { Job } from "./types";

export function isNoSampleCommand(text: string): boolean {
  const plain = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  return /^(?:@.+?\s+)?\/?(?:hom\s+nay\s+)?(?:khong|ko|k|chua)\s+co(?:\s+mau)?(?:\s+@.+)?$/.test(plain);
}

export function cancelableScheduleJobs(jobs: Job[], today: string, customerId: string, currentOnly = false): Job[] {
  return jobs.filter((job) => {
    if (![2, 4].includes(job.job_status_id ?? 0)) return false;
    if (!job.scheduled_delivery_ts?.startsWith(today) || !job.labels?.includes(SCHEDULE_JOB_LABEL)) return false;
    if (currentOnly) {
      // Future pickups remain parked. A missing release time is only safe for a real driver.
      if (job.delivery_driver_id === PROXY_DRIVER_ID) return false;
      if (job.send_to_driver_at) {
        const timestamp = job.send_to_driver_at.trim().replace(" ", "T").replace(/\+(\d{2})$/, "+$1:00");
        const release = new Date(/[Zz]$|[+-]\d{2}:\d{2}$/.test(timestamp) ? timestamp : `${timestamp}+07:00`).getTime();
        if (!Number.isFinite(release) || release > Date.now()) return false;
      } else if (!job.delivery_driver_id) return false;
    }
    const pickup = job.stops?.find((stop) => stop.stop_type_id === 1);
    return pickup?.customer_id === customerId &&
      pickup.stop_status_id === 1 &&
      !pickup.activity_started_ts && !pickup.activity_arrived_ts && !pickup.activity_completed_ts;
  });
}

/** Cancel exactly one of today's unstarted fixed pickups for this customer. */
export async function cancelScheduledPickup(customerId: string, currentOnly = false): Promise<string> {
  try {
    const today = vnDate();
    const candidates = cancelableScheduleJobs(await getJobsByDate(today, "prod"), today, customerId, currentOnly);
    if (candidates.length !== 1) {
      return candidates.length === 0
        ? (currentOnly ? "Hiện không có chuyến lấy mẫu cố định nào đủ điều kiện huỷ." : "Hôm nay không có chuyến lấy mẫu cố định nào đang chờ huỷ.")
        : "Có nhiều chuyến đang chờ. Vui lòng liên hệ điều phối để xác nhận chuyến cần huỷ.";
    }
    // Recheck the pickup immediately before cancelling; the day list can lag.
    const current = await getJobDetails(candidates[0].job_id, "prod");
    if (cancelableScheduleJobs(current.data ? [current.data] : [], today, customerId, currentOnly).length !== 1) {
      return "Chuyến đã thay đổi trạng thái, nên bot không huỷ. Vui lòng liên hệ điều phối.";
    }
    return await cancelJobFromTimeline(candidates[0].job_id, today, "prod")
      ? `Đã huỷ chuyến lấy mẫu cố định hôm nay (Job #${candidates[0].job_id}).`
      : "Không huỷ được chuyến trên Cartrack. Vui lòng liên hệ điều phối.";
  } catch (error) {
    console.error("[zalo-pickup] cancellation failed", error);
    return "Không kiểm tra được chuyến trên Cartrack. Vui lòng liên hệ điều phối.";
  }
}
