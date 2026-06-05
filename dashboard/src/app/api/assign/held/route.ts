import { NextRequest, NextResponse } from "next/server";
import { getJobDetails, updateJobStops, updateJobScheduledDeliveryTs, type Env } from "@/lib/cartrack";
import { autoAssignCycle } from "@/lib/assign";
import { loadConfigFromSheets } from "@/lib/config";
import {
  getHeldJobs,
  removeHeldJob,
  acquireCycleLock,
  releaseCycleLock,
  pushSmartRun,
  pushRunLog,
} from "@/lib/smart-log-kv";

// The "assign anyway" POST runs a real assign cycle, which can take a while.
export const maxDuration = 60;

/** GET — note-held jobs, read from Redis (populated by the cron cycle). */
export async function GET() {
  const held = await getHeldJobs();
  return NextResponse.json({ held });
}

/** POST { jobId, scheduledAt? } — assign or schedule a held job despite its note.
 *  scheduledAt: "YYYY-MM-DD HH:MM:SS" VN time — parks to proxy driver queue.
 *  Omit scheduledAt to run the full assign cycle immediately. */
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

    const details = await getJobDetails(jobId, env);
    const rawStops = (details.data?.stops ?? []) as {
      stop_id?: number; stop_type_id?: number; customer_id?: string; customer_name?: string;
    }[];
    const updatedStops = rawStops
      .filter((s) => s.stop_id && s.stop_type_id && s.customer_id)
      .map((s) => ({
        stop_id: s.stop_id!,
        stop_type_id: s.stop_type_id!,
        customer_id: s.customer_id!,
        ...(s.customer_name ? { customer_name: s.customer_name } : {}),
        ...(s.stop_type_id === 1
          ? { delivery_windows: [{ time_from: timeFrom, time_to: timeFrom }] }
          : {}),
      }));

    // Run both PUTs in parallel: delivery_windows on pickup stop + scheduled_delivery_ts on job.
    const [stopsRes, schedRes] = await Promise.all([
      updateJobStops(jobId, updatedStops, env),
      updateJobScheduledDeliveryTs(jobId, String(body.scheduledAt), env),
    ]);
    if (!stopsRes.ok || !schedRes.ok) {
      return NextResponse.json(
        { ok: false, error: `Lên lịch thất bại (stops ${stopsRes.status}, sched ${schedRes.status})` },
        { status: 502 }
      );
    }
    await removeHeldJob(jobId).catch(() => {});
    return NextResponse.json({ ok: true, scheduled: true });
  }

  // Share the cycle lock so this can't run alongside a cron cycle.
  const gotLock = await acquireCycleLock();
  if (!gotLock) {
    return NextResponse.json({ ok: false, error: "A cycle is already running — try again in a moment." }, { status: 409 });
  }

  try {
    const config = await loadConfigFromSheets();
    if (!config) {
      return NextResponse.json({ ok: false, error: "Failed to load config" }, { status: 500 });
    }

    const logs = await autoAssignCycle(config, env, false, new Set([jobId]));
    await pushSmartRun(logs).catch(() => {});
    await pushRunLog(logs).catch(() => {});

    const assigned = logs.some((l) => l.level === "OK" && l.msg.includes(`Job ${jobId}`));
    if (assigned) await removeHeldJob(jobId).catch(() => {});

    const errorLine = logs.find((l) => l.level === "ERROR" && l.msg.includes(`Job ${jobId}`));
    return NextResponse.json({ ok: assigned, assigned, error: errorLine?.msg ?? null, logs });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  } finally {
    await releaseCycleLock().catch(() => {});
  }
}
