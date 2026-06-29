import { NextRequest, NextResponse, after } from "next/server";
import { getJobDetails, updateJobStops, updateJobScheduledDeliveryTs, updateJobSendToDriverAt, assignJob, PROXY_DRIVER_ID, type Env } from "@/lib/cartrack";
import { NOTE_APPROVED_MARK } from "@/lib/job-filters";
import { getHeldJobs, removeHeldJob, addHeldJob, pushRunLog } from "@/lib/smart-log-kv";
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
  const note = stops
    .map((s) => s.note?.trim())
    .filter((n) => n && n !== "Call before delivery")
    .join(" | ");
  return { customer, route, note };
}

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
        log(`Job ${jobId} - Lên lịch THẤT BẠI: ${err} | ${route}`, "ERROR");
        await addHeldJob({ job_id: jobId, customer, note, error: `Lên lịch lỗi: ${err}` }).catch(() => {});
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
          const [stopsRes, sendRes, parkRes] = await Promise.all([
            updateJobStops(jobId, updatedStops, env),
            updateJobSendToDriverAt(jobId, sendAt, env),
            assignJob(PROXY_DRIVER_ID, jobId, env),
          ]);
          if (!stopsRes.ok) return putBack(`stops ${stopsRes.status}`);
          if (!sendRes.ok) return putBack(`send ${sendRes.status}`);
          if (parkRes.status !== 200) return putBack(`park ${parkRes.status}`);
        } else {
          const stopsRes = await updateJobStops(jobId, updatedStops, env);
          if (!stopsRes.ok) return putBack(`stops ${stopsRes.status}`);
        }

        await removeHeldJob(jobId).catch(() => {});
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
      log(`Job ${jobId} - Duyệt giao THẤT BẠI: ${err} | ${route}`, "ERROR");
      await addHeldJob({ job_id: jobId, customer, note, error: `Duyệt giao lỗi: ${err}` }).catch(() => {});
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
      if (!stopsRes.ok) return putBack(`stops ${stopsRes.status}`);

      await removeHeldJob(jobId).catch(() => {});
      const { route } = heldFields(jobId, stops);
      log(`Job ${jobId} - Đã duyệt ghi chú, sẽ giao ở chu kỳ kế tiếp | ${route}`);
    } catch (e) {
      await putBack(String(e));
    }
  });

  return NextResponse.json({ ok: true, approved: true, queued: true });
}
