import { NextRequest, NextResponse } from "next/server";
import {
  jsonRpc, getDrivers, getJobDetails, assignJobViaUpdate, type Env,
} from "@/lib/cartrack";
import { loadConfigFromSheets, isValidDriverId } from "@/lib/config";
import { isCompletedOrRejectedStop, STOP_STATUS } from "@/lib/job-filters";
import { verifySession, NV_COOKIE } from "@/lib/driver-session";
import { appendNhanViecLog } from "@/lib/sheets-writer";
import { vnDate, vnDayWindow, vnTimestamp } from "@/lib/time";
import type { Job, Stop, TimelineRoute, TimelineStop } from "@/lib/types";

// Jobs a driver may claim: mapped to their smart_driver_id, pickup still open.
// "Open pickup" = pickup stop status is NOT 4 (Hoàn thành) or 5 (Từ chối).
//
// The job LIST is fetched via the JSON-RPC timeline route API
// (delivery_timeline_route_list) — the same source smart-assign and the main
// assign cycle use. It returns today's ASSIGNED jobs grouped by driver route,
// which is exactly the scope we want ("assigned job, pickup not done").

const PICKUP = 1;
const DROPOFF = 2;
const DELIVERY = 3;

/** All timeline stops for `dateVn`, flattened across every driver route. JSON-RPC. */
async function fetchTimelineStops(dateVn: string, env: Env = "prod"): Promise<TimelineStop[]> {
  const out = await jsonRpc<{ routes?: TimelineRoute[] }>(
    "delivery_timeline_route_list",
    { data: { scheduleType: "scheduled", filter: vnDayWindow(dateVn) } },
    { env }
  );
  if (!out.ok) throw new Error(`timeline route list failed: ${out.error}`);
  const stops: TimelineStop[] = [];
  for (const r of out.result?.routes ?? []) for (const s of r.orderedStops ?? []) stops.push(s);
  return stops;
}

/** customer_ids whose config mapping lists this driver in smart_driver_id[]. */
async function customerIdsForDriver(driverId: string): Promise<Set<string>> {
  const config = await loadConfigFromSheets();
  const set = new Set<string>();
  for (const m of config?.mappings ?? []) {
    if (m.smart_driver_id.includes(driverId) && m.customer_id) set.add(m.customer_id);
  }
  return set;
}

// ── GET /api/driver-jobs?env=prod ────────────────────────────────────────────
// The driver is taken from the signed session cookie, NEVER from client input —
// so a driver can only ever see their own jobs.

export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const session = verifySession(req.cookies.get(NV_COOKIE)?.value);
  if (!session || !isValidDriverId(session.driver_id)) {
    return NextResponse.json(
      { ok: false, expired: true, error: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại." },
      { status: 401 }
    );
  }
  const driverId = session.driver_id;

  try {
    const customerIds = await customerIdsForDriver(driverId);
    // Driver is valid but mapped to no smart customers → nothing to claim.
    if (customerIds.size === 0) {
      return NextResponse.json({ ok: true, recognized: false, jobs: [] });
    }

    const [stops, drivers] = await Promise.all([
      fetchTimelineStops(vnDate(), env),
      getDrivers(env), // for the current-assignee display name
    ]);

    const nameById = new Map<string, string>();
    for (const d of drivers) {
      const nm = `${d.first_name ?? ""} ${d.last_name ?? ""}`.trim();
      if (d.delivery_driver_id) nameById.set(d.delivery_driver_id, nm);
    }

    // Group stops by job so we can locate each job's pickup + dropoff.
    const byJob = new Map<number, TimelineStop[]>();
    for (const s of stops) {
      if (!s.jobId) continue;
      if (!byJob.has(s.jobId)) byJob.set(s.jobId, []);
      byJob.get(s.jobId)!.push(s);
    }

    const jobs = [];
    for (const [jobId, js] of byJob) {
      const pickup = js.find((s) => s.stopTypeId === PICKUP);
      if (!pickup?.customerId || pickup.stopStatusId == null) continue;
      if (!customerIds.has(pickup.customerId)) continue;
      if (isCompletedOrRejectedStop(pickup.stopStatusId)) continue;

      const dropoff = js.find((s) => s.stopTypeId === DROPOFF) ?? js.find((s) => s.stopTypeId === DELIVERY);
      const currentDriverId = pickup.deliveryDriverId || null;
      jobs.push({
        job_id: jobId,
        reference_number: pickup.referenceNumber || null,
        pickup_name: pickup.customerName || null,
        dropoff_name: dropoff?.customerName || null,
        pickup_status_id: pickup.stopStatusId,
        pickup_status_label: STOP_STATUS[pickup.stopStatusId]?.label ?? null,
        current_driver_id: currentDriverId,
        current_driver_name: currentDriverId ? (nameById.get(currentDriverId) || null) : null,
        is_mine: currentDriverId === driverId,
      });
    }

    return NextResponse.json({ ok: true, recognized: true, jobs });
  } catch (e) {
    console.error("[driver-jobs] GET error:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { ok: false, error: "Không tải được danh sách công việc." },
      { status: 502 }
    );
  }
}

// ── POST /api/driver-jobs  { job_id, driver_id }  → claim to self ────────────

const claimPickupStop = (job: Job): Stop | undefined =>
  (job.stops ?? []).find((s) => s.stop_type_id === PICKUP);

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  // Claim FOR the authenticated driver only — id comes from the cookie, not body.
  const session = verifySession(req.cookies.get(NV_COOKIE)?.value);
  if (!session || !isValidDriverId(session.driver_id)) {
    return NextResponse.json(
      { ok: false, expired: true, error: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại." },
      { status: 401 }
    );
  }
  const driverId = session.driver_id;

  let jobId = 0;
  try {
    const body = await req.json();
    jobId = Number(body?.job_id);
  } catch {
    return NextResponse.json({ ok: false, error: "Yêu cầu không hợp lệ." }, { status: 400 });
  }

  if (!Number.isFinite(jobId) || jobId <= 0) {
    return NextResponse.json({ ok: false, error: "Thiếu thông tin công việc." }, { status: 400 });
  }

  try {
    // Re-verify claimability server-side against the single job: pickup customer
    // must map to this driver's smart_driver_id AND pickup must still be open.
    // Targeted single-job lookup (getJobDetails) — cheap; the LIST uses JSON-RPC.
    const customerIds = await customerIdsForDriver(driverId);
    const details = await getJobDetails(jobId, env);
    const job = details?.data as Job | undefined;
    if (!job || !job.job_id) {
      return NextResponse.json({ ok: false, error: "Không tìm thấy công việc." }, { status: 404 });
    }
    const pickup = claimPickupStop(job);
    const claimable =
      !!pickup?.customer_id &&
      pickup.stop_status_id != null &&
      customerIds.has(pickup.customer_id) &&
      !isCompletedOrRejectedStop(pickup.stop_status_id);
    if (!claimable) {
      return NextResponse.json(
        { ok: false, error: "Công việc này không thuộc tuyến của bạn hoặc đã lấy hàng xong." },
        { status: 403 }
      );
    }

    // Capture the previous assignee BEFORE reassigning (for the audit log).
    const prevDriver = job.driver
      ? `${job.driver.first_name ?? ""} ${job.driver.last_name ?? ""}`.trim()
      : "";

    const { status, driverName } = await assignJobViaUpdate(jobId, driverId, env);
    if (status < 200 || status >= 300) {
      return NextResponse.json(
        { ok: false, error: `Nhận việc thất bại (Cartrack ${status}).` },
        { status: 502 }
      );
    }

    // Best-effort audit log to Google Sheets — never fail the claim if it errors.
    try {
      const dropoff = (job.stops ?? []).find((s) => s.stop_type_id === DROPOFF);
      const statusId = pickup?.stop_status_id ?? null;
      await appendNhanViecLog([
        vnTimestamp(),
        session.driver_name || driverName || "",
        driverId,
        jobId,
        job.reference_number ?? "",
        pickup?.customer_name ?? "",
        dropoff?.customer_name ?? "",
        prevDriver || (job.delivery_driver_id ?? ""),
        statusId != null ? (STOP_STATUS[statusId]?.label ?? String(statusId)) : "",
      ]);
    } catch (e) {
      console.error("[driver-jobs] audit log append failed:", e instanceof Error ? e.message : e);
    }

    return NextResponse.json({ ok: true, job_id: jobId, driver_name: driverName });
  } catch (e) {
    console.error("[driver-jobs] POST error:", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, error: "Nhận việc thất bại. Vui lòng thử lại." }, { status: 502 });
  }
}
