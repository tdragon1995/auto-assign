import { NextRequest, NextResponse } from "next/server";
import { loadConfigFromSheets } from "@/lib/config";
import { getUnassignedJobs, getFleetwebCookie, type Env } from "@/lib/cartrack";
import { isDriverOnShift, getCustomerIdFromJob } from "@/lib/assign";
import type { LogEntry, LogLevel } from "@/lib/types";

const JSONRPC_URL = "https://fleetweb-vn.cartrack.com/jsonrpc/index.php";
const TZ = "Asia/Ho_Chi_Minh";

function nowTs(): string {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function makeLog(msg: string, level: LogLevel = "INFO"): LogEntry {
  return { ts: nowTs(), level, msg };
}

function vnDateString(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date()).slice(0, 10);
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

// Fetch assigned job IDs for smart drivers where pickup stop hasn't started yet
async function fetchAssignedJobIds(
  smartDriverIds: Set<string>,
  dateVn: string,
  auth: string,
  cookie: string
): Promise<number[]> {
  try {
    const res = await fetch(JSONRPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth, Cookie: cookie },
      body: JSON.stringify({
        version: "2.0",
        method: "delivery_timeline_route_list",
        id: 2,
        params: {
          data: {
            scheduleType: "scheduled",
            filter: {
              from: `${dateVn}T00:00:00+07:00`,
              to:   `${dateVn}T23:59:59+07:00`,
            },
          },
        },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();

    const routes: {
      routeId: string;
      orderedStops?: {
        jobId?: number;
        stopTypeId?: number;
        stopStatusId?: number;
      }[];
    }[] = data.result?.routes ?? [];

    const jobIds: number[] = [];
    for (const route of routes) {
      const driverId = route.routeId.replace(/^driver_/, "");
      if (!smartDriverIds.has(driverId)) continue;
      for (const stop of route.orderedStops ?? []) {
        if (stop.stopTypeId === 1 && stop.stopStatusId === 1 && stop.jobId != null) {
          jobIds.push(stop.jobId);
        }
      }
    }
    return [...new Set(jobIds)];
  } catch {
    return [];
  }
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
          filter: {
            from: `${dateVn}T00:00:00+07:00`,
            to:   `${dateVn}T23:59:59+07:00`,
          },
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
    const dateVn = vnDateString();
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

    const cookie = await getFleetwebCookie();
    if (!cookie) {
      log("AUTO-PLAN: could not obtain fleetweb cookie", "ERROR");
      return NextResponse.json({ logs }, { status: 500 });
    }

    // Fetch unassigned jobs + assigned-but-not-started jobs in parallel
    const [unassignedData, assignedJobIds] = await Promise.all([
      getUnassignedJobs(1, 50, env),
      fetchAssignedJobIds(onShiftDriverIds, dateVn, auth, cookie),
    ]);

    const unassignedSmartJobIds = (unassignedData.data ?? [])
      .filter((j) => {
        const cid = getCustomerIdFromJob(j);
        return cid !== null && smartCustomerIds.has(cid);
      })
      .map((j) => j.job_id);

    let jobIds = [...new Set([...unassignedSmartJobIds, ...assignedJobIds])];

    if (jobIds.length === 0) {
      log("AUTO-PLAN: no jobs to plan");
      return NextResponse.json({ logs });
    }

    const driverIds = [...onShiftDriverIds];
    log(`AUTO-PLAN: ${jobIds.length} job(s) [${unassignedSmartJobIds.length} unassigned + ${assignedJobIds.length} assigned] → ${driverIds.length} driver(s)`);

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
          log(`AUTO-PLAN fired (retry) | requestId: ${retry.requestId} | routingJob: ${retry.routingJobId} | ${jobIds.length} job(s) → ${driverIds.length} driver(s)`, "OK");
        }
      } else {
        log(`AUTO-PLAN error: ${result.error}`, "ERROR");
      }
    } else {
      log(`AUTO-PLAN fired | requestId: ${result.requestId} | routingJob: ${result.routingJobId} | ${jobIds.length} job(s) → ${driverIds.length} driver(s)`, "OK");
    }

    return NextResponse.json({ logs });
  } catch (e) {
    log(`AUTO-PLAN unexpected error: ${e}`, "ERROR");
    return NextResponse.json({ logs }, { status: 500 });
  }
}
