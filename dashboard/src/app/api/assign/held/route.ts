import { NextRequest, NextResponse } from "next/server";
import { getJobDetails, updateJobStops, type Env } from "@/lib/cartrack";
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

  // ── Scheduled path: proxy-assign + set send_to_driver_at, no cycle lock needed ──
  if (body.scheduledAt) {
    const [assignRes, setRes] = await Promise.all([
      assignJob(PROXY_DRIVER_ID, jobId, env),
      updateJobSendToDriverAt(jobId, body.scheduledAt, env),
    ]);
    if (assignRes.status === 200 && setRes.ok) {
      await removeHeldJob(jobId).catch(() => {});
      return NextResponse.json({ ok: true, scheduled: true });
    }
    return NextResponse.json(
      { ok: false, error: `Lên lịch thất bại (assign ${assignRes.status}, set ${setRes.status})` },
      { status: 500 }
    );
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
