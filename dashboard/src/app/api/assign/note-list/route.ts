import { NextRequest, NextResponse } from "next/server";
import { normalizeNote } from "@/lib/job-filters";
import { getNoteLearning, setNoteDecisionState, pushRunLog } from "@/lib/smart-log-kv";
import { vnTimestamp } from "@/lib/time";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

/**
 * The safe-note list the supervisor controls.
 *
 * GET  — sentences already accepted, and the ones the engine is proposing
 *        (three consecutive "Giao ngay" approvals, no "Hẹn giờ" in between).
 * POST — accept a proposal onto the list, or dismiss it for good.
 *
 * Accepting takes effect within a few minutes: each running instance holds the
 * list briefly to keep the Upstash command count down, so an acceptance reaches
 * them as their own copies expire.
 */
export async function GET() {
  const { accepted, suggestions } = await getNoteLearning();
  return NextResponse.json({ accepted, suggestions });
}

export async function POST(req: NextRequest) {
  let body: { sentence?: string; action?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* handled below */
  }
  // Normalized on the way in: the dashboard shows the sentence as a branch typed
  // it, and that is not the key it is stored under.
  const norm = normalizeNote(body.sentence);
  const action = body.action === "dismiss" ? "dismissed" : "accepted";
  if (!norm) {
    return NextResponse.json({ ok: false, error: "Missing sentence" }, { status: 400 });
  }

  const ok = await setNoteDecisionState(norm, action);
  if (!ok) {
    return NextResponse.json({ ok: false, error: "Không tìm thấy ghi chú này" }, { status: 404 });
  }

  await pushRunLog([{
    ts: vnTimestamp(),
    level: "OK",
    msg: action === "accepted"
      ? `Ghi chú "${norm}" đã được thêm vào danh sách tự giao`
      : `Ghi chú "${norm}" bị bỏ qua, sẽ không đề xuất lại`,
  }]).catch(() => {});

  return NextResponse.json({ ok: true, action });
}
