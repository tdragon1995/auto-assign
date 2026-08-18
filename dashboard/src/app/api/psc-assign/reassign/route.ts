import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, assignJob, getLiveDrivers, getDrivers, type Env } from "@/lib/cartrack";
import { driversAtPscPickup, NEARBY_RADIUS_M, type NearbyCandidate } from "@/lib/nearby-driver";
import { isCompletedOrRejectedStop } from "@/lib/job-filters";
import { loadLeaveEntries, isDriverOnLeave } from "@/lib/leave-config";
import { pushRunLog } from "@/lib/smart-log-kv";
import { vnTimestamp } from "@/lib/time";
import type { Stop } from "@/lib/types";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

/**
 * Branch-triggered driver change — the escape hatch for the cases the roster cannot
 * describe.
 *
 * The engine assigns from configuration: shift windows, pools, leave, substitutes. That
 * covers the ordinary day and nothing else. It cannot know that today's driver is stuck
 * across the city while a different one is standing in reception — and the branch can see
 * exactly that. So the branch is handed the one fact the engine lacks, who is physically
 * here, and allowed to act on it.
 *
 * Nothing here runs automatically. The engine keeps assigning by roster; this fires only
 * when a person at the branch decides the roster is wrong for this one trip.
 */

/** Positions for every live driver. Fleetweb list first (active accounts only, ~110-190ms),
 *  REST as fallback, so a fleetweb outage costs accuracy rather than the whole feature. */
async function livePositions(env: Env): Promise<NearbyCandidate[]> {
  const fast = await getLiveDrivers(env);
  if (fast && fast.length > 0) return fast;
  const rest = await getDrivers(env).catch(() => []);
  return rest.map((d) => ({
    deliveryDriverId: d.delivery_driver_id,
    firstName: d.first_name,
    lastName: d.last_name,
    latitude: d.latitude,
    longitude: d.longitude,
    isLoggedIn: d.is_online,
    lastOnlineTs: d.last_login_ts ?? null,
  }));
}

/** The trip, plus the pickup stop every guard below turns on. */
async function loadJob(jobId: number, env: Env) {
  const res = await fetch(`${BASE_URL}/jobs/${jobId}`, { headers: getHeaders(env), cache: "no-store" });
  if (!res.ok) return null;
  const data = (await res.json())?.data;
  if (!data) return null;
  const stops: Stop[] = data.stops ?? [];
  return { data, pickup: stops.find((s) => s.stop_type_id === 1) ?? null };
}

/**
 * A trip can change hands until the samples are actually in somebody's bag. En route and
 * arrived still count as changeable — that is exactly the moment a branch discovers the
 * assigned driver is not coming — but collected does not: the box has moved, and pointing
 * the paperwork at a different person would only lose track of it.
 */
function blockingReason(status: number | null, pickup: Stop | null): string | null {
  if (status === 5) return "Chuyến đã hoàn thành.";
  if (status === 3 || status === 7) return "Chuyến đã huỷ hoặc thất bại.";
  if (pickup && isCompletedOrRejectedStop(pickup.stop_status_id ?? 0)) {
    return "Giao Nhận Mẫu đã lấy mẫu xong, không thể đổi.";
  }
  return null;
}

/** GET ?job_id= — who is standing at this trip's pickup right now, nearest first. */
export async function GET(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const jobId = Number(req.nextUrl.searchParams.get("job_id"));
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: "Thiếu mã chuyến" }, { status: 400 });
  }

  try {
    const job = await loadJob(jobId, env);
    if (!job) return NextResponse.json({ error: "Không tìm thấy chuyến" }, { status: 404 });

    const blocked = blockingReason(job.data.job_status_id ?? null, job.pickup);
    if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });

    const pickupId = job.pickup?.customer_id;
    if (!pickupId) return NextResponse.json({ error: "Chuyến không có điểm lấy mẫu" }, { status: 409 });

    const [live, leaveEntries] = await Promise.all([
      livePositions(env),
      // An unreadable leave sheet offers nobody rather than somebody who is off today.
      // A wrong name here is a wasted trip; an empty list is a two-minute wait.
      loadLeaveEntries().catch(() => null),
    ]);
    if (!leaveEntries) {
      return NextResponse.json({ error: "Chưa đọc được lịch nghỉ, vui lòng thử lại" }, { status: 503 });
    }

    const current = job.data.delivery_driver_id ?? null;
    const drivers = driversAtPscPickup(live, pickupId)
      .filter((d) => !isDriverOnLeave(d.driverId, leaveEntries).onLeave)
      // Offering the driver who already holds the trip would just be a no-op button.
      .filter((d) => d.driverId !== current);

    return NextResponse.json({ radius_m: NEARBY_RADIUS_M, drivers });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

/** POST { job_id, driver_id } — hand this trip to that driver. */
export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const body = await req.json().catch(() => ({}));
    const jobId = Number(body?.job_id);
    const driverId = String(body?.driver_id ?? "").trim();
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return NextResponse.json({ error: "Thiếu mã chuyến" }, { status: 400 });
    }
    if (!/^[0-9a-f-]{36}$/i.test(driverId)) {
      return NextResponse.json({ error: "Giao Nhận Mẫu không hợp lệ" }, { status: 400 });
    }

    const job = await loadJob(jobId, env);
    if (!job) return NextResponse.json({ error: "Không tìm thấy chuyến" }, { status: 404 });
    const blocked = blockingReason(job.data.job_status_id ?? null, job.pickup);
    if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });

    const pickupId = job.pickup?.customer_id;
    if (!pickupId) return NextResponse.json({ error: "Chuyến không có điểm lấy mẫu" }, { status: 409 });

    // Re-checked at the moment of the change, not merely when the list was drawn. A branch
    // can sit on that screen for minutes, and the driver they tap may have ridden off or
    // gone on leave in between.
    const [live, leaveEntries] = await Promise.all([
      livePositions(env),
      loadLeaveEntries().catch(() => null),
    ]);
    if (!leaveEntries) {
      return NextResponse.json({ error: "Chưa đọc được lịch nghỉ, vui lòng thử lại" }, { status: 503 });
    }
    const here = driversAtPscPickup(live, pickupId).find((d) => d.driverId === driverId);
    if (!here) {
      return NextResponse.json(
        { error: `Giao Nhận Mẫu này không còn trong bán kính ${NEARBY_RADIUS_M}m` },
        { status: 409 }
      );
    }
    if (isDriverOnLeave(driverId, leaveEntries).onLeave) {
      return NextResponse.json({ error: "Giao Nhận Mẫu này đang nghỉ phép" }, { status: 409 });
    }

    const res = await assignJob(driverId, jobId, env);
    if (res.status !== 200) {
      // Cartrack refused. The trip keeps whoever it had, so a failed change costs nothing
      // but the tap — say so plainly and let the branch pick somebody else.
      return NextResponse.json(
        { error: "Không đổi được, vui lòng chọn Giao Nhận Mẫu khác", status: res.status },
        { status: 502 }
      );
    }

    // A hand-change should read as a hand-change in the supervisor's log. The engine did
    // not decide this, a branch did — and a location that keeps overruling the roster is
    // the roster telling you something.
    pushRunLog([{
      ts: vnTimestamp(),
      level: "OK",
      msg: `Job ${jobId} - Chi nhánh đổi Giao Nhận Mẫu sang ${here.name} (${here.metres}m tại điểm lấy) | ${job.data.reference_number ?? ""}`,
    }]).catch(() => {});

    return NextResponse.json({ success: true, job_id: jobId, driver_id: driverId, driver_name: here.name });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
