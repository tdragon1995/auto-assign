import { botToken } from "./kiot-bot";
import { SCHEDULE_JOB_LABEL } from "./schedule-job";
import { claimLateAlert } from "./smart-log-kv";
import type { Env } from "./cartrack";
import type { Job, LogLevel } from "./types";
import { sendZaloMessage } from "./zalo";

const CHAT_BY_CUSTOMER_ID: Record<string, string> = {
  "51bfb168-446f-11ed-888f-506b8dbc8dfb": "zgr-1c7aa981bbcf52910bde",
  "f88dfab6-b522-11ee-bb52-506b8d9879b5": "zgr-5f2b2b46331ada44830b",
};
const MESSAGE = "Dạ, sắp đến giờ lấy mẫu cố định của bên mình rồi ạ. Bên mình hôm nay có mẫu không ạ, cho Diag xin xác nhận với ạ?";

/** Call only after Cartrack confirms that a queue-driver job was released. */
export async function remindScheduledPickup(
  job: Job,
  env: Env,
  log: (msg: string, level?: LogLevel) => void,
): Promise<void> {
  if (env !== "prod" || !job.labels?.includes(SCHEDULE_JOB_LABEL)) return;
  const pickup = job.stops?.find((stop) => stop.stop_type_id === 1);
  const chatId = pickup?.customer_id ? CHAT_BY_CUSTOMER_ID[pickup.customer_id] : undefined;
  if (
    !pickup || !chatId ||
    pickup.stop_status_id !== 1 ||
    pickup.activity_started_ts || pickup.activity_arrived_ts || pickup.activity_completed_ts
  ) return;

  const token = botToken();
  if (!token) {
    log(`Job ${job.job_id} - Fixed-pickup Zalo reminder skipped: Pharmacy bot token missing`, "WARN");
    return;
  }
  const redisUrl = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) {
    log(`Job ${job.job_id} - Fixed-pickup Zalo reminder skipped: deduplication storage missing`, "WARN");
    return;
  }

  try {
    // Claim before sending: a stale queue-driver list cannot repeat the reminder.
    if (!(await claimLateAlert(job.job_id, env, 86400, "fixed-pickup-reminder"))) return;
    if (!(await sendZaloMessage(token, chatId, MESSAGE))) {
      log(`Job ${job.job_id} - Fixed-pickup Zalo reminder failed`, "WARN");
    }
  } catch (error) {
    log(`Job ${job.job_id} - Fixed-pickup Zalo reminder failed: ${error}`, "WARN");
  }
}
