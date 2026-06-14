import { NextRequest, NextResponse } from "next/server";
import { getJobDetails, updateJobStops, updateJobScheduledDeliveryTs, type Env } from "@/lib/cartrack";
import { NOTE_APPROVED_MARK } from "@/lib/job-filters";
import { getHeldJobs, removeHeldJob, pushRunLog } from "@/lib/smart-log-kv";
import { vnTimestamp } from "@/lib/time";

// Both POST paths are quick Cartrack edits (stop notes / scheduled ts) — no
// synchronous assign cycle, so run on the edge (no cold start) near Cartrack VN.
export const runtime = "edge";
export const preferredRegion = "sin1";

/** GET — note-held jobs, read from Redis (populated by the cron cycle). */
export async function GET() {
  const held = await getHeldJobs();
  return NextResponse.json({ held });
}

/** POST { jobId, scheduledAt? } — clear a held job's note gate.
 *  scheduledAt: "YYYY-MM-DD HH:MM:SS" VN time — parks to proxy driver queue.
 *  Omit scheduledAt ("Giao ngay") to stamp the approved mark on the note; the
 *  next cron cycle then bypasses the gate and assigns it. */
export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  let body: { jobId?: number; scheduledAt?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* handled below */
  }
  const jobId = Number(body.jobId);
  if (!jobId || Number.isNaN(jobId)) {
    return NextResponse.json({ ok: false, error: "Missing jobId" }, { status: 400 });
  }

  // ── Scheduled path: add delivery_window to pickup stop, leave unassigned ──────
  // The engine picks it up next cycle: note gate bypasses (hasWindow), window
  // parking parks it to the proxy queue at the right time.
  if (body.scheduledAt) {
    // Extract "HH:MM:SS" from "YYYY-MM-DD HH:MM:SS"
    const timePart = String(body.scheduledAt).match(/(\d{2}:\d{2}:\d{2})$/)?.[1];
    if (!timePart) {
      return NextResponse.json({ ok: false, error: "Invalid scheduledAt format" }, { status: 400 });
    }
    const timeFrom = `${timePart}+07:00`;
    // time_to = time_from + 30 min (Cartrack rejects zero-length windows)
    const [hh, mm, ss] = timePart.split(":").map(Number);
    const toTotal = hh * 60 + mm + 30;
    const timeTo = `${String(Math.floor(toTotal / 60) % 24).padStart(2, "0")}:${String(toTotal % 60).padStart(2, "0")}:${String(ss).padStart(2, "0")}+07:00`;

    // Steps 1 & 2 run together — they're independent (the details read doesn't
    // touch stops). updateJobStops still runs after, since Cartrack only accepts
    // delivery_windows once the job is Scheduled (schedRes must be ok first).
    const [schedRes, details] = await Promise.all([
      updateJobScheduledDeliveryTs(jobId, String(body.scheduledAt), env),
      getJobDetails(jobId, env),
    ]);
    if (!schedRes.ok) {
      return NextResponse.json(
        { ok: false, error: `Lên lịch thất bại (sched ${schedRes.status})`, details: schedRes.body },
        { status: 502 }
      );
    }

    const rawStops = (details.data?.stops ?? []) as {
      stop_id?: number; stop_type_id?: number; customer_id?: string; customer_name?: string; note?: string;
    }[];
    const updatedStops = rawStops
      .filter((s) => s.stop_id && s.stop_type_id && s.customer_id)
      .map((s) => ({
        stop_id: s.stop_id!,
        stop_type_id: s.stop_type_id!,
        customer_id: s.customer_id!,
        ...(s.customer_name ? { customer_name: s.customer_name } : {}),
        ...(s.note ? { note: s.note } : {}),
        ...(s.stop_type_id === 1
          ? { delivery_windows: [{ time_from: timeFrom, time_to: timeTo }] }
          : {}),
      }));

    const stopsRes = await updateJobStops(jobId, updatedStops, env);
    if (!stopsRes.ok) {
      return NextResponse.json(
        { ok: false, error: `Lên lịch thất bại (stops ${stopsRes.status})`, details: stopsRes.body },
        { status: 502 }
      );
    }

    await removeHeldJob(jobId).catch(() => {});
    return NextResponse.json({ ok: true, scheduled: true });
  }

  // ── "Giao ngay" path: stamp the approved mark on the note, leave unassigned ──
  // No assign cycle here, so no cycle-lock contention. The next cron cycle sees the
  // mark, bypasses the note gate (isNoteApproved), and assigns the job normally.
  try {
    const details = await getJobDetails(jobId, env);
    const rawStops = (details.data?.stops ?? []) as {
      stop_id?: number; stop_type_id?: number; customer_id?: string; customer_name?: string; note?: string;
    }[];
    const eligibleStops = rawStops.filter((s) => s.stop_id && s.stop_type_id && s.customer_id);
    if (eligibleStops.length === 0) {
      return NextResponse.json({ ok: false, error: "Job không có điểm dừng hợp lệ" }, { status: 502 });
    }

    // Append the mark to every stop that carries a real (blocking) note, so it
    // travels with the text the driver reads. "Call before delivery" never blocks,
    // so it's left untouched.
    const updatedStops = eligibleStops.map((s) => {
      const note = s.note?.trim();
      const blocking = note && note !== "Call before delivery";
      const newNote =
        blocking && !note.includes(NOTE_APPROVED_MARK) ? `${s.note} ${NOTE_APPROVED_MARK}` : s.note;
      return {
        stop_id: s.stop_id!,
        stop_type_id: s.stop_type_id!,
        customer_id: s.customer_id!,
        ...(newNote ? { note: newNote } : {}),
      };
    });

    const stopsRes = await updateJobStops(jobId, updatedStops, env);
    if (!stopsRes.ok) {
      return NextResponse.json(
        { ok: false, error: `Duyệt giao thất bại (stops ${stopsRes.status})`, details: stopsRes.body },
        { status: 502 }
      );
    }

    await removeHeldJob(jobId).catch(() => {});

    // Log the approval so the supervisor sees it in the activity log right away —
    // the actual assignment (and its own log line) happens on the next cron cycle.
    const customer =
      eligibleStops.find((s) => s.stop_type_id === 1)?.customer_name ??
      eligibleStops[0]?.customer_name ?? `Job ${jobId}`;
    await pushRunLog([{
      ts: vnTimestamp(),
      level: "OK",
      msg: `Job ${jobId} - Đã duyệt ghi chú → sẽ giao ở chu kỳ kế tiếp | ${customer}`,
    }]).catch(() => {});

    return NextResponse.json({ ok: true, approved: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
