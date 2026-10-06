import { cancelJobFromTimeline, getJobDetails, getJobsByDate, PROXY_DRIVER_ID } from "./cartrack";
import { SCHEDULE_JOB_LABEL } from "./schedule-job";
import { parseVnTimestamp, vnDate } from "./time";
import { claimLateAlert } from "./smart-log-kv";
import { PICKUP_REMINDER_CLAIM } from "./scheduled-pickup-reminder";
import type { Job } from "./types";

const NO_PICKUP_CORE = [
  "khong co mau", "hom nay khong co mau", "khong co mau nao", "het mau", "khong con mau",
  "khong co benh pham", "khong co hang", "khong co gi gui", "khong co gi de gui",
  "khong can lay", "khong can qua lay", "khong can den", "khong can ghe", "khong can chay",
  "khoi lay", "khoi qua", "khoi ghe", "khong phai qua", "dung qua",
  "hom nay nghi", "hom nay dong cua", "nghi le", "nghi phep", "tam nghi", "ben em nghi",
  "phong kham nghi", "hom nay khong lay", "bo luot hom nay", "huy lich lay", "huy pick",
  "ko co mau", "k co mau", "ko mau", "0 co mau", "o co mau", "ko co hang", "k co hang",
  "ko can lay", "k can lay", "ko can qua", "k can qua", "hnay ko co", "hnay k co mau",
  "hnay ko co mau", "hnay khong co mau", "hnay nghi", "hnay ko lay", "hnay k lay",
  "nay ko co mau", "nay khong co mau",
  "chua co mau", "chua co", "chua co hang", "chua co benh pham", "chua c mau", "chx co mau",
  "chua co mau nha",
];
const POSITIVE_OVERRIDE = [
  "co mau", "co hang", "co benh pham", "lay giup", "lay dum", "qua lay", "ghe lay", "den lay",
  "nho qua", "nho ghe", "nho lay", "mau gap", "gap", "van lay", "van qua", "van can lay", "van co",
  // "con mau" means samples remain; only "khong con mau" is a negative.
  "con mau", "con hang", "con benh pham",
];
const FUTURE_DATE_WORDS = [
  "mai", "ngay mai", "mot", "hom sau", "ngay kia", "thu 2", "thu 3", "thu 4", "thu 5", "thu 6",
  "thu 7", "chu nhat", "cn", "thu hai", "thu ba", "thu tu", "thu nam", "thu sau", "thu bay",
  "tuan sau", "tuan toi", "thang sau", "thang toi",
];
const TODAY_WORDS = ["hom nay", "hnay", "hum nay", "nay", "sang nay", "chieu nay", "toi nay"];
const NO_PICKUP_REGEX = [
  /\b(khong|ko|k|0|o|chua|chx)\s*mau\b/,
  /\b(khong|ko|k|0|o)\s*(co|con)\s*(mau|hang|benh pham|gi)\b/,
  /\b(khong|ko|k|0|o)\s*can\s*(lay|qua|den|ghe|chay)\b/,
  /\b(khoi|dung)\s*(lay|qua|ghe|den)\b/,
  /\b(hom nay|hnay|nay)\s*(nghi|dong cua|khong lay|ko lay)\b/,
  /\bhet\s*mau\b/,
  /\bhuy\s*(lich|pick|lay)\b/,
];
function phrasePattern(phrases: string[], flags = ""): RegExp {
  return new RegExp(`\\b(?:${phrases.join("|")})\\b`, flags);
}
const CORE_PATTERN = phrasePattern(NO_PICKUP_CORE);
const POSITIVE_PATTERN = phrasePattern(POSITIVE_OVERRIDE, "g");
const FUTURE_PATTERN = phrasePattern(FUTURE_DATE_WORDS);
const SHORT_NEGATIVE_PATTERN = new RegExp(`^/?(?:da )?(?:(?:${TODAY_WORDS.join("|")}) )?(?:khong|ko|k|0|o|chua|chx) (?:co(?: mau)?|mau)(?: (?:a|ah|nhe|nha))*[.!]?$`);

export function classifyPickupReply(text: string): "cancel" | "review" | "ignore" {
  const plain = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d")
    .toLowerCase().replace(/\s+/g, " ").trim()
    .replace(/@bot (?:giao nhan mau|dieu phoi x)\b/g, "").trim();
  const core = CORE_PATTERN.test(plain) || NO_PICKUP_REGEX.some(pattern => pattern.test(plain)) || SHORT_NEGATIVE_PATTERN.test(plain);
  if (!core) return "ignore";
  const positive = [...plain.matchAll(POSITIVE_PATTERN)].some(match => {
    const before = plain.slice(0, match.index);
    // Negation belongs to this phrase, not an unrelated earlier "ko mau" clause.
    return !/\b(?:khong|ko|k|0|o|chua|chx|khoi|dung|huy|bo)(?: (?:can|phai|con|co|qua|den|ghe|van|lich|luot)){0,3} $/.test(before);
  });
  const laterPositive = /\b(?:lat|luc|chieu|toi) (?:moi )?(?:co|lay)\b/.test(plain);
  if (positive || laterPositive || FUTURE_PATTERN.test(plain) || plain.includes("?")) return "review";
  return "cancel";
}

/** Review/positive/date-scoped replies never enter the Cartrack cancellation path. */
export async function getPickupReply(customerId: string, text: string, chatId: string): Promise<string | null> {
  const decision = classifyPickupReply(text);
  if (decision === "ignore") return null;
  if (decision === "review") {
    console.warn("[zalo-pickup] needs review", { customerId, chatId, text });
    return "Nội dung cần điều phối xác nhận thêm. Bot chưa huỷ chuyến lấy mẫu. Vui lòng liên hệ điều phối.";
  }
  return cancelScheduledPickup(customerId);
}

export function cancelableScheduleJobs(jobs: Job[], today: string, customerId: string, currentOnly = false, now = Date.now()): Job[] {
  return jobs.filter((job) => {
    if (![2, 4].includes(job.job_status_id ?? 0)) return false;
    if (!job.scheduled_delivery_ts?.startsWith(today) || !job.labels?.includes(SCHEDULE_JOB_LABEL)) return false;
    if (currentOnly) {
      // Future pickups remain parked. A missing release time is only safe for a real driver.
      if (job.delivery_driver_id === PROXY_DRIVER_ID) return false;
      if (job.send_to_driver_at) {
        const timestamp = job.send_to_driver_at.trim().replace(" ", "T").replace(/\+(\d{2})$/, "+$1:00");
        const release = new Date(/[Zz]$|[+-]\d{2}:\d{2}$/.test(timestamp) ? timestamp : `${timestamp}+07:00`).getTime();
        if (!Number.isFinite(release) || release > now) return false;
      } else if (!job.delivery_driver_id) return false;
    }
    const pickup = job.stops?.find((stop) => stop.stop_type_id === 1);
    return pickup?.customer_id === customerId &&
      pickup.stop_status_id === 1 &&
      !pickup.activity_started_ts && !pickup.activity_arrived_ts && !pickup.activity_completed_ts;
  });
}

/** Prefer the released pickup; before its reminder, select only the next appointment.
 * Include cancelled jobs when finding that slot so a repeated reply cannot skip ahead. */
export function pickupCancellationCandidates(jobs: Job[], today: string, customerId: string, now = Date.now()): Job[] {
  const current = cancelableScheduleJobs(jobs, today, customerId, true, now);
  if (current.length) return current;
  const upcoming = jobs.filter(job => job.scheduled_delivery_ts?.startsWith(today) &&
    job.labels?.includes(SCHEDULE_JOB_LABEL) && job.stops?.some(stop => stop.stop_type_id === 1 && stop.customer_id === customerId))
    .map(job => {
      const time = job.stops?.find(stop => stop.stop_type_id === 1)?.delivery_windows?.[0]?.time_from?.slice(0, 8);
      return { job, at: time && /^\d{2}:\d{2}:\d{2}$/.test(time) ? parseVnTimestamp(`${today} ${time}`).getTime() : NaN };
    }).filter(slot => Number.isFinite(slot.at) && slot.at >= now);
  const next = Math.min(...upcoming.map(slot => slot.at));
  return cancelableScheduleJobs(upcoming.filter(slot => slot.at === next).map(slot => slot.job), today, customerId);
}

/** Cancel exactly one current or upcoming unstarted fixed pickup for this customer. */
export async function cancelScheduledPickup(customerId: string): Promise<string> {
  try {
    const today = vnDate();
    const candidates = pickupCancellationCandidates(await getJobsByDate(today, "prod"), today, customerId);
    if (candidates.length !== 1) {
      return candidates.length === 0
        ? "Hiện không có chuyến lấy mẫu cố định nào đủ điều kiện huỷ."
        : "Có nhiều chuyến đang chờ. Vui lòng liên hệ điều phối để xác nhận chuyến cần huỷ.";
    }
    // Recheck the pickup immediately before cancelling; the day list can lag.
    const current = await getJobDetails(candidates[0].job_id, "prod");
    if (cancelableScheduleJobs(current.data ? [current.data] : [], today, customerId).length !== 1) {
      return "Chuyến đã thay đổi trạng thái, nên bot không huỷ. Vui lòng liên hệ điều phối.";
    }
    if (!(await cancelJobFromTimeline(candidates[0].job_id, today, "prod"))) {
      return "Không huỷ được chuyến trên Cartrack. Vui lòng liên hệ điều phối.";
    }
    // Consume the existing reminder claim so even a stale release list stays silent.
    await claimLateAlert(candidates[0].job_id, "prod", 86400, PICKUP_REMINDER_CLAIM)
      .catch(error => console.error("[zalo-pickup] cancelled, reminder suppression failed", error));
    return `Đã huỷ chuyến lấy mẫu cố định hôm nay (Job #${candidates[0].job_id}).`;
  } catch (error) {
    console.error("[zalo-pickup] cancellation failed", error);
    return "Không kiểm tra được chuyến trên Cartrack. Vui lòng liên hệ điều phối.";
  }
}
