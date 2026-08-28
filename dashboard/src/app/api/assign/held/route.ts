import { NextRequest, NextResponse, after } from "next/server";
import { getJobDetails, updateJobStops, updateJobScheduledDeliveryTs, parkOnProxy, type Env } from "@/lib/cartrack";
import { NOTE_APPROVED_MARK, isBlockingNote, normalizeNote } from "@/lib/job-filters";
import { getHeldJobs, removeHeldJob, addHeldJob, pushRunLog, recordNoteDecision } from "@/lib/smart-log-kv";
import { vnTimestamp, parseVnTimestamp, vnDate } from "@/lib/time";

type RawStop = { stop_id?: number; stop_type_id?: number; customer_id?: string; customer_name?: string; note?: string };

/** Pickup customer name, the "<pickup> → <dropoff>" route (for the uniform log
 *  suffix; stops are already fetched, so no extra Cartrack call), and the joined
 *  blocking notes — for putting a failed job back. */
function heldFields(jobId: number, stops: RawStop[]): { customer: string; route: string; note: string } {
  const pickup = stops.find((s) => s.stop_type_id === 1)?.customer_name;
  const dropoff = stops.find((s) => s.stop_type_id === 2)?.customer_name;
  const customer = pickup ?? `Job ${jobId}`;
  const route = `${pickup ?? "—"} → ${dropoff ?? "—"}`;
  // No `now`: this is the text shown on the review row, and a note is worth
  // showing whether or not the safe-list would have released it at this hour.
  const note = stops
    .map((s) => s.note?.trim())
    .filter((n) => isBlockingNote(n))
    .join(" | ");
  return { customer, route, note };
}

/**
 * The sentences on this job that a decision is evidence about — the blocking
 * ones, paired with their comparable form.
 *
 * Only "Giao ngay" and "Hẹn giờ" feed the tally. "Chọn tài xế" deliberately does
 * not: naming a driver by hand can just as easily mean the note REQUIRES that
 * driver, so it is evidence in no direction and is left out rather than guessed
 * at.
 */
const learnableNotes = (stops: RawStop[]) =>
  stops
    .map((s) => s.note?.trim())
    .filter((n): n is string => isBlockingNote(n))
    .map((n) => ({ norm: normalizeNote(n), sample: n }));

// Cartrack writes are slow (~5-10s each) and we make two per action, so we never
// block the click on them. POST validates, returns immediately, and finishes the
// Cartrack work in the background via after() — the result lands in the activity
// log a few seconds later. nodejs runtime (not edge) so the deferred work has the
// full maxDuration to complete; the instant response doesn't need edge speed.
export const runtime = "nodejs";
export const preferredRegion = "sin1";
export const maxDuration = 60;

const log = (msg: string, level: "OK" | "INFO" | "WARN" | "ERROR" = "OK") =>
  pushRunLog([{ ts: vnTimestamp(), level, msg }]).catch(() => {});

/** GET — note-held jobs, read from Redis (populated by the cron cycle). */
export async function GET() {
  const held = await getHeldJobs();
  return NextResponse.json({ held });
}

/** POST { jobId, scheduledAt? } — clear a held job's note gate.
 *  scheduledAt ("Lên lịch"): set a delivery window so the engine parks it.
 *  No scheduledAt ("Giao ngay"): stamp the approved mark so the next cron cycle
 *  bypasses the note gate. Both return instantly; the slow Cartrack writes run in
 *  the background and report success/failure to the activity log. */
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

  // ── Scheduled path ("Lên lịch") ──────────────────────────────────────────────
  if (body.scheduledAt) {
    const scheduledAt = String(body.scheduledAt);
    // Extract "HH:MM:SS" from "YYYY-MM-DD HH:MM:SS" — validate before responding.
    const timePart = scheduledAt.match(/(\d{2}:\d{2}:\d{2})$/)?.[1];
    if (!timePart) {
      return NextResponse.json({ ok: false, error: "Invalid scheduledAt format" }, { status: 400 });
    }
    const timeFrom = `${timePart}+07:00`;
    // time_to = time_from + 30 min (Cartrack rejects zero-length windows)
    const [hh, mm, ss] = timePart.split(":").map(Number);
    const toTotal = hh * 60 + mm + 30;
    const timeTo = `${String(Math.floor(toTotal / 60) % 24).padStart(2, "0")}:${String(toTotal % 60).padStart(2, "0")}:${String(ss).padStart(2, "0")}+07:00`;
    // Release 60 min before the appointment, matching the cycle's window-parking lead.
    // Future-day schedules (+1/+2) ALWAYS park and release 60 min before — the daily
    // fetch is filtered to scheduled_delivery_ts = today, so an un-parked future-day
    // job is invisible until its day; only the proxy (scanned with no date filter)
    // reliably releases it on time. Same-day: park only when >60 min out, else assign
    // directly — a near-term same-day park would put send_to_driver_at in the past and
    // bounce through the proxy for one cycle instead of going straight to a driver.
    const scheduledMs = parseVnTimestamp(scheduledAt).getTime();
    const isFutureDay = scheduledAt.slice(0, 10) > vnDate();
    const shouldPark = isFutureDay || scheduledMs - Date.now() > 60 * 60 * 1000;
    const sendAt = vnTimestamp(new Date(scheduledMs - 60 * 60 * 1000));

    after(async () => {
      let stops: RawStop[] = [];
      const putBack = async (err: string) => {
        const { customer, route, note } = heldFields(jobId, stops);
        // The raw reason (e.g. "sched 422") stays in the activity log for
        // debugging; the supervisor-facing banner gets plain language.
        log(`Job ${jobId} - Lên lịch THẤT BẠI: ${err} | ${route}`, "ERROR");
        // Only note-held jobs belong in the note-review queue. The scheduler is
        // also reachable from the "Chưa cấu hình (Sheet)" rows, whose jobs carry
        // no note — putting one there would render a note task with an empty
        // note. It needs no putting back anyway: a failed park leaves the job
        // unassigned, so the next cycle re-flags it in "Cần xử lý" by itself.
        if (!note) return;
        await addHeldJob({ job_id: jobId, customer, note, error: `Không lên lịch được` }).catch(() => {});
      };
      try {
        // Schedule-type update and details read are independent — run together.
        // updateJobStops runs after, since Cartrack only accepts delivery_windows
        // once the job is Scheduled (schedRes must be ok first).
        const [schedRes, details] = await Promise.all([
          updateJobScheduledDeliveryTs(jobId, scheduledAt, env),
          getJobDetails(jobId, env),
        ]);
        stops = (details.data?.stops ?? []) as RawStop[];
        if (!schedRes.ok) return putBack(`sched ${schedRes.status}`);

        const updatedStops = stops
          .filter((s) => s.stop_id && s.stop_type_id && s.customer_id)
          .map((s) => ({
            stop_id: s.stop_id!,
            stop_type_id: s.stop_type_id!,
            customer_id: s.customer_id!,
            ...(s.note ? { note: s.note } : {}),
            ...(s.stop_type_id === 1 ? { delivery_windows: [{ time_from: timeFrom, time_to: timeTo }] } : {}),
          }));

        // Park on the proxy driver now (with send_to_driver_at), instead of relying
        // on a later cycle to park it via the window heuristic — that cycle never
        // runs for +1/+2 day schedules because it fetches by scheduled_delivery_ts =
        // today. releaseDueProxyJobs scans the proxy driver with NO date filter, so a
        // multi-day parked job is found and released on its scheduled day. Window +
        // scheduled_delivery_ts are still set above: the window bypasses the note gate
        // on release, the date lets that day's cycle re-fetch the released job.
        // Near-term SAME-DAY schedules (<=60 min) skip parking: the next cycle's
        // window path sees diffMin <= 60 and assigns them straight to a driver.
        if (shouldPark) {
          // Window first, then park — and the park's own two writes are sequential
          // with a read-back (see parkOnProxy). Firing the release-time write and the
          // hand-over together loses the release time often enough to strand a job on
          // the queue driver for the rest of the day.
          const stopsRes = await updateJobStops(jobId, updatedStops, env);
          if (!stopsRes.ok) return putBack(`stops ${stopsRes.status}`);
          const park = await parkOnProxy(jobId, sendAt, env);
          if (!park.ok) return putBack(`park ${park.detail}`);
          // Parking on the proxy driver (and writing the pickup's from_day_offset:0
          // window) makes Cartrack recompute scheduled_delivery_ts back to the park
          // day (today), clobbering the future-day date set above. For a +1/+2 day
          // schedule that strands the job: releaseDueProxyJobs un-parks it on its
          // scheduled day (driven by send_to_driver_at), but the cycle then re-fetches
          // by scheduled_delivery_ts = today and never sees a job still dated today's
          // park day. Re-assert the date as the FINAL write so it sticks. (rollover
          // sidesteps this by unassigning before re-dating; here the park is required,
          // so we re-date after it instead.)
          const reschedRes = await updateJobScheduledDeliveryTs(jobId, scheduledAt, env);
          if (!reschedRes.ok) return putBack(`resched ${reschedRes.status}`);
        } else {
          const stopsRes = await updateJobStops(jobId, updatedStops, env);
          if (!stopsRes.ok) return putBack(`stops ${stopsRes.status}`);
        }

        await removeHeldJob(jobId).catch(() => {});
        // A time was given instead of an approval: this sentence changed the job,
        // so its run of clean approvals goes back to zero.
        await recordNoteDecision(learnableNotes(stops), false).catch(() => {});
        const { route } = heldFields(jobId, stops);
        log(`Job ${jobId} - Đã lên lịch lúc ${timePart.slice(0, 5)}${shouldPark ? ` · parked until ${sendAt}` : ""} | ${route}`);
      } catch (e) {
        await putBack(String(e));
      }
    });

    return NextResponse.json({ ok: true, scheduled: true, queued: true });
  }

  // ── "Giao ngay" path: stamp the approved mark in the background ───────────────
  after(async () => {
    let stops: RawStop[] = [];
    const putBack = async (err: string) => {
      const { customer, route, note } = heldFields(jobId, stops);
      // Raw reason to the log; plain language to the supervisor's banner.
      log(`Job ${jobId} - Duyệt giao THẤT BẠI: ${err} | ${route}`, "ERROR");
      await addHeldJob({ job_id: jobId, customer, note, error: `Không duyệt giao được` }).catch(() => {});
    };
    try {
      const details = await getJobDetails(jobId, env);
      stops = (details.data?.stops ?? []) as RawStop[];
      const eligibleStops = stops.filter((s) => s.stop_id && s.stop_type_id && s.customer_id);
      if (eligibleStops.length === 0) return putBack("không có điểm dừng hợp lệ");

      // Append the mark to every stop that carries a real (blocking) note, so it
      // travels with the text the driver reads. "Call before delivery" never blocks.
      const updatedStops = eligibleStops.map((s) => {
        const note = s.note?.trim();
        const blocking = isBlockingNote(note);
        const newNote =
          blocking && note && !note.includes(NOTE_APPROVED_MARK) ? `${s.note} ${NOTE_APPROVED_MARK}` : s.note;
        return {
          stop_id: s.stop_id!,
          stop_type_id: s.stop_type_id!,
          customer_id: s.customer_id!,
          ...(newNote ? { note: newNote } : {}),
        };
      });

      const stopsRes = await updateJobStops(jobId, updatedStops, env);
      if (!stopsRes.ok) return putBack(`stops ${stopsRes.status}`);

      await removeHeldJob(jobId).catch(() => {});
      // Sent as-is: one more consecutive approval for each sentence on the job.
      // Once a sentence reaches the threshold the dashboard OFFERS it for the safe
      // list — nothing is ever added here, on its own.
      await recordNoteDecision(learnableNotes(stops), true).catch(() => {});
      const { route } = heldFields(jobId, stops);
      log(`Job ${jobId} - Đã duyệt ghi chú, sẽ giao ở chu kỳ kế tiếp | ${route}`);
    } catch (e) {
      await putBack(String(e));
    }
  });

  return NextResponse.json({ ok: true, approved: true, queued: true });
}
