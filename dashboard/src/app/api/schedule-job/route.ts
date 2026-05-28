import { NextRequest, NextResponse } from "next/server";
import type { Env } from "@/lib/cartrack";
import { runScheduleJobCycle } from "@/lib/schedule-job";
import { getLastRun, saveLastRun } from "@/lib/schedule-job-kv";

export const runtime = "nodejs";
export const preferredRegion = "sin1";
export const maxDuration = 60;

/**
 * POST /api/schedule-job
 *   ?env=prod|uat (default prod)
 *   ?mode=retry — re-runs only ERROR rows from the last saved run
 *
 * Triggered daily by Vercel Cron at 05:00 Asia/Ho_Chi_Minh.
 * Also callable manually from the dashboard.
 */
export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const mode = req.nextUrl.searchParams.get("mode");
  const isRetry = mode === "retry";

  // Vercel Cron sets this header; we accept either it OR no header (manual call).
  const fromVercelCron = req.headers.get("user-agent")?.includes("vercel-cron") ?? false;
  const trigger: "cron" | "manual" | "retry" = isRetry
    ? "retry"
    : fromVercelCron
      ? "cron"
      : "manual";

  try {
    let retryOnly = undefined;
    if (isRetry) {
      const last = await getLastRun();
      if (!last) {
        return NextResponse.json(
          { error: "No previous run found to retry from" },
          { status: 400 },
        );
      }
      retryOnly = last.results.filter((r) => r.status === "ERROR");
      if (retryOnly.length === 0) {
        return NextResponse.json({
          message: "Nothing to retry — last run had no errors",
          last,
        });
      }
    }

    const { date, weekday, results } = await runScheduleJobCycle(env, { retryOnly });

    // For retry, merge new results back into the previous run record so the
    // dashboard shows the latest status per row.
    let record;
    if (isRetry) {
      const last = await getLastRun();
      const merged = (last?.results ?? []).map((prev) => {
        const updated = results.find(
          (r) => r.reference_number === prev.reference_number,
        );
        return updated ?? prev;
      });
      record = {
        ts: new Date().toISOString(),
        date,
        weekday,
        trigger,
        results: merged,
      };
    } else {
      record = {
        ts: new Date().toISOString(),
        date,
        weekday,
        trigger,
        results,
      };
    }

    await saveLastRun(record);

    const counts = {
      ok: record.results.filter((r) => r.status === "OK").length,
      skipped: record.results.filter((r) => r.status === "SKIPPED").length,
      error: record.results.filter((r) => r.status === "ERROR").length,
    };

    return NextResponse.json({
      success: true,
      trigger,
      date,
      weekday,
      counts,
      results: record.results,
    });
  } catch (e) {
    return NextResponse.json(
      { error: String(e) },
      { status: 500 },
    );
  }
}

// GET is allowed for Vercel Cron compatibility (some configurations use GET).
export async function GET(req: NextRequest) {
  return POST(req);
}
