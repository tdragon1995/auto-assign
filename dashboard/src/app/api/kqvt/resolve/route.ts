/**
 * "Cần xử lý" → KQ/VT chờ giao quá 24h → "Đã xử lý": the dispatcher has dealt with a
 * waiting Kết quả / Vật tư item by hand, so it leaves the waiting list (lib/kqvt.ts).
 * The warning and the hand-over attempts stop; the collect job in Cartrack is left as it
 * is — cancel or finish it there if that is what handling it meant.
 */
import { NextRequest, NextResponse } from "next/server";
import { dropPending, loadPending } from "@/lib/kqvt";
import { pushRunLog } from "@/lib/smart-log-kv";
import { vnTimestamp } from "@/lib/time";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

export async function POST(req: NextRequest) {
  const jobId = Number((await req.json().catch(() => null))?.job_id);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: "Job không hợp lệ" }, { status: 400 });
  }
  try {
    const entry = (await loadPending()).find((e) => e.job_id === jobId);
    await dropPending(jobId);
    if (entry) {
      await pushRunLog([{ ts: vnTimestamp(), level: "INFO", msg: `Job ${jobId} - KQ/VT đánh dấu đã xử lý | ${entry.psc_name} → ${entry.client_name}` }]).catch(() => {});
    }
    // Already gone (another tab, or the engine dropped it) is still a success.
    return NextResponse.json({ ok: true, found: !!entry });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 502 });
  }
}
