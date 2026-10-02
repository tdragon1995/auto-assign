import { NextRequest, NextResponse } from "next/server";
import { cancelJobFromTimeline, getJobDetails, getJobsByDate } from "@/lib/cartrack";
import { SCHEDULE_JOB_LABEL } from "@/lib/schedule-job";
import { SAMPLE_PICKUP_CUSTOMER_ID } from "@/lib/scheduled-pickup-reminder";
import { vnDate } from "@/lib/time";
import type { Job } from "@/lib/types";
import { sendZaloMessage } from "@/lib/zalo";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

export function isNoSampleCommand(text: string): boolean {
  const plain = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  return /^(?:@.+?\s+)?\/?(?:hom\s+nay\s+)?(?:khong|k)\s+co\s+mau(?:\s+@.+)?$/.test(plain);
}

export function cancelableScheduleJobs(jobs: Job[], today: string): Job[] {
  return jobs.filter((job) => {
    if (![2, 4].includes(job.job_status_id ?? 0)) return false;
    if (!job.scheduled_delivery_ts?.startsWith(today) || !job.labels?.includes(SCHEDULE_JOB_LABEL)) return false;
    const pickup = job.stops?.find((stop) => stop.stop_type_id === 1);
    return pickup?.customer_id === SAMPLE_PICKUP_CUSTOMER_ID &&
      pickup.stop_status_id === 1 &&
      !pickup.activity_started_ts && !pickup.activity_arrived_ts && !pickup.activity_completed_ts;
  });
}

type Update = {
  event_name?: string;
  message?: {
    text?: string;
    chat?: { id?: string | number; chat_type?: string };
    from?: { is_bot?: boolean };
  };
};

export async function POST(req: NextRequest) {
  const secret = process.env.ZALO_SAMPLE_WEBHOOK_SECRET;
  if (!secret || req.headers.get("x-bot-api-secret-token") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let update: Update;
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") return NextResponse.json({ ok: true });
    update = body.result ?? body;
    if (!update || typeof update !== "object") return NextResponse.json({ ok: true });
  }
  catch { return NextResponse.json({ ok: true }); }

  console.info("[zalo-sample] received", {
    event: update.event_name,
    chatId: update.message?.chat?.id,
    chatType: update.message?.chat?.chat_type,
  });

  if (update.event_name !== "message.text.received" || update.message?.from?.is_bot) {
    return NextResponse.json({ ok: true });
  }
  const chat = update.message?.chat;
  const chatId = chat?.id == null ? "" : String(chat.id);
  if (!chatId || chat?.chat_type !== "GROUP") return NextResponse.json({ ok: true });

  const token = process.env.ZALO_SAMPLE_BOT_TOKEN;
  if (!token) return NextResponse.json({ ok: true });
  const text = update.message?.text ?? "";

  // Setup command: the group can reveal its own chat ID before it is allowlisted.
  if (!process.env.ZALO_SAMPLE_CHAT_ID && /^(?:@.+?\s+)?\/id(?:\s+@.+)?$/i.test(text.trim())) {
    const sent = await sendZaloMessage(token, chatId, `Chat ID: ${chatId}`);
    if (!sent) console.error("[zalo-sample] chat ID reply failed", { chatId });
    return NextResponse.json({ ok: true });
  }
  if (chatId !== process.env.ZALO_SAMPLE_CHAT_ID || !isNoSampleCommand(text)) {
    return NextResponse.json({ ok: true });
  }

  try {
    const today = vnDate();
    const candidates = cancelableScheduleJobs(await getJobsByDate(today, "prod"), today);
    let reply: string;
    if (candidates.length !== 1) {
      reply = candidates.length === 0
        ? "Hôm nay không có chuyến lấy mẫu cố định nào đang chờ huỷ."
        : "Có nhiều chuyến đang chờ. Vui lòng liên hệ điều phối để xác nhận chuyến cần huỷ.";
    } else {
      // Recheck the pickup immediately before cancelling; the day list can lag.
      const current = await getJobDetails(candidates[0].job_id, "prod");
      if (cancelableScheduleJobs(current.data ? [current.data] : [], today).length !== 1) {
        reply = "Chuyến đã thay đổi trạng thái, nên bot không huỷ. Vui lòng liên hệ điều phối.";
      } else {
        reply = await cancelJobFromTimeline(candidates[0].job_id, today, "prod")
          ? `Đã huỷ chuyến lấy mẫu cố định hôm nay (Job #${candidates[0].job_id}).`
          : "Không huỷ được chuyến trên Cartrack. Vui lòng liên hệ điều phối.";
      }
    }
    await sendZaloMessage(token, chatId, reply);
  } catch (error) {
    console.error("[zalo-sample] cancellation failed", error);
    await sendZaloMessage(token, chatId, "Không kiểm tra được chuyến trên Cartrack. Vui lòng liên hệ điều phối.");
  }
  return NextResponse.json({ ok: true });
}
