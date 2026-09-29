import { botToken } from "./kiot-bot";
import { SCHEDULE_JOB_LABEL } from "./schedule-job";
import { claimLateAlert } from "./smart-log-kv";
import type { Env } from "./cartrack";
import type { Job, LogLevel } from "./types";
import { sendZaloMessage } from "./zalo";

const PICKUP_CUSTOMER_ID = "51bfb168-446f-11ed-888f-506b8dbc8dfb";
const CHAT_ID = "zgr-1c7aa981bbcf52910bde";
const MESSAGE = "Dạ, sắp đến giờ lấy mẫu cố định của bên mình rồi ạ. Bên mình hôm nay có mẫu không ạ, cho Diag xin xác nhận với ạ?";

/** Call only after Cartrack confirms that a queue-driver job was released. */
export async function remindScheduledPickup(
  job: Job,
  env: Env,
  log: (msg: string, level?: LogLevel) => void,
): Promise<void> {
  if (env !== "prod" || !job.labels?.includes(SCHEDULE_JOB_LABEL)) return;
  const pickup = job.stops?.find((stop) => stop.stop_type_id === 1);
  if (
    pickup?.customer_id !== PICKUP_CUSTOMER_ID ||
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
    if (!(await sendZaloMessage(token, CHAT_ID, MESSAGE))) {
      log(`Job ${job.job_id} - Fixed-pickup Zalo reminder failed`, "WARN");
    }
  } catch (error) {
    log(`Job ${job.job_id} - Fixed-pickup Zalo reminder failed: ${error}`, "WARN");
  }
}
