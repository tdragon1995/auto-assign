import { NextRequest, NextResponse } from "next/server";
import { loadConfigFromSheets } from "@/lib/config";
import { getUnassignedJobs, getDriverJobs, getFleetwebCookie, JSONRPC_URL, type Env } from "@/lib/cartrack";
import { isDriverOnShift, getCustomerIdFromJob, isJobRecent, jobHasNotes, autoAssignCycle } from "@/lib/assign";
import { vnDate, vnTimestamp, vnDayWindow } from "@/lib/time";
import type { LogEntry, LogLevel } from "@/lib/types";

function makeLog(msg: string, level: LogLevel = "INFO"): LogEntry {
  return { ts: vnTimestamp(), level, msg };
}

// Parse "JobID 34265464 is not assignable, JobID 34265135 is not assignable" → [34265464, 34265135]
function parseUnassignableJobIds(error: string): number[] {
  const ids: number[] = [];
  const parts = error.split(", ");
  for (const part of parts) {
    if (!part.includes("is not assignable")) continue;
    const words = part.split(" ");
    const jobIdIdx = words.indexOf("JobID");
    if (jobIdIdx !== -1 && jobIdIdx + 1 < words.length) {
      const id = parseInt(words[jobIdIdx + 1]);
      if (!isNaN(id)) ids.push(id);
    }
  }
  return ids;
}

async function callAutoPlan(
  jobIds: number[],
  driverIds: string[],
  dateVn: string,
  auth: string,
  cookie: string
): Promise<{ error: string | null; requestId?: number; routingJobId?: string }> {
  const res = await fetch(JSONRPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth, Cookie: cookie },
    body: JSON.stringify({
      version: "2.0",
      method: "delivery_timeline_autoplan",
      id: 10,
      params: {
        data: {
          jobIds,
          driverIds,
          scheduleType: "scheduled",
          filter: vnDayWindow(dateVn),
        },
      },
    }),
  });

  const data = await res.json();
  if (data.error) return { error: String(data.error) };
  return {
    error: null,
    requestId: data.result?.optimizedResult?.requestId,
    routingJobId: data.result?.routingServiceResponse?.job_id,
  };
}

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const logs: LogEntry[] = [];
  const log = (msg: string, level: LogLevel = "INFO") => logs.push(makeLog(msg, level));

  try {
    const config = await loadConfigFromSheets();
    if (!config) {
      log("Failed to load config", "ERROR");
      return NextResponse.json({ logs }, { status: 500 });
    }

    const now = new Date();
    const dateVn = vnDate();
    const auth = process.env.CARTRACK_AUTH ?? "";
    if (!auth) {
      log("CARTRACK_AUTH not set", "ERROR");
      return NextResponse.json({ logs }, { status: 500 });
    }

    // Collect on-shift smart driver IDs + their customer IDs
    const smartCustomerIds = new Set<string>();
    const onShiftDriverIds = new Set<string>();

    for (const m of config.mappings) {
      if (m.smart_driver_id.length > 0 && isDriverOnShift(m, now)) {
        smartCustomerIds.add(m.customer_id);
        for (const id of m.smart_driver_id) onShiftDriverIds.add(id);
      }
    }

    if (onShiftDriverIds.size === 0) {
      log("AUTO-PLAN: no smart drivers on shift");
      return NextResponse.json({ logs });
    }

    const maxAge = config.job_max_age_minutes;

    // Fetch unassigned jobs + driver assigned jobs in parallel
    const driverIds = [...onShiftDriverIds];
    const [unassignedData, ...driverJobArrays] = await Promise.all([
      getUnassignedJobs(1, 50, env),
      ...driverIds.map((id) => getDriverJobs(id, dateVn, env)),
    ]);

    // Filter unassigned jobs
    const unassignedSmartJobIds = (unassignedData.data ?? [])
      .filter((j) => {
        if (!isJobRecent(j, maxAge)) return false;
        if (jobHasNotes(j)) return false;
        const cid = getCustomerIdFromJob(j);
        return cid !== null && smartCustomerIds.has(cid);
      })
      .map((j) => j.job_id);

    // Filter driver jobs: pickup not started + recent + no notes + customer match
    const assignedSmartJobIds: number[] = [];
    for (const jobs of driverJobArrays) {
      for (const j of jobs) {
        if (!isJobRecent(j, maxAge)) continue;
        if (jobHasNotes(j)) continue;
        const cid = getCustomerIdFromJob(j);
        if (!cid || !smartCustomerIds.has(cid)) continue;
        const pickupStop = (j.stops ?? []).find((s) => s.stop_type_id === 1);
        if (!pickupStop || pickupStop.stop_status_id !== 1) continue;
        assignedSmartJobIds.push(j.job_id);
      }
    }

    let jobIds = [...new Set([...unassignedSmartJobIds, ...assignedSmartJobIds])];

    if (jobIds.length === 0) {
      log("AUTO-PLAN: no jobs to plan");
      return NextResponse.json({ logs });
    }

    log(`AUTO-PLAN: ${jobIds.length} job(s) [${unassignedSmartJobIds.length} unassigned + ${assignedSmartJobIds.length} assigned] → ${driverIds.length} driver(s)`);

    // Need fleetweb cookie for JSON-RPC autoplan call
    const cookie = await getFleetwebCookie();
    if (!cookie) {
      log("AUTO-PLAN: could not obtain fleetweb cookie", "ERROR");
      return NextResponse.json({ logs }, { status: 500 });
    }

    // Fire auto-plan
    const result = await callAutoPlan(jobIds, driverIds, dateVn, auth, cookie);

    if (result.error) {
      const badIds = parseUnassignableJobIds(result.error);

      if (badIds.length > 0) {
        for (const id of badIds) log(`AUTO-PLAN: Job ${id} removed — not assignable`, "WARN");
        jobIds = jobIds.filter((id) => !badIds.includes(id));

        if (jobIds.length === 0) {
          log("AUTO-PLAN: no assignable jobs remaining after exclusions", "WARN");
          return NextResponse.json({ logs });
        }

        // Retry once with cleaned job list
        const retry = await callAutoPlan(jobIds, driverIds, dateVn, auth, cookie);
        if (retry.error) {
          log(`AUTO-PLAN retry failed: ${retry.error}`, "ERROR");
        } else {
          log(`AUTO-PLAN: ${jobIds.length} job(s) planned across ${driverIds.length} driver(s)`, "OK");
        }
      } else {
        log(`AUTO-PLAN error: ${result.error}`, "ERROR");
      }
    } else {
      log(`AUTO-PLAN: ${jobIds.length} job(s) planned across ${driverIds.length} driver(s)`, "OK");
    }

    // Run fixed-driver assignments (skipSmart=true — smart jobs handled above by Cartrack planner)
    const fixedLogs = await autoAssignCycle(config, env, true);
    logs.push(...fixedLogs);

    return NextResponse.json({ logs });
  } catch (e) {
    log(`AUTO-PLAN unexpected error: ${e}`, "ERROR");
    return NextResponse.json({ logs }, { status: 500 });
  }
}
