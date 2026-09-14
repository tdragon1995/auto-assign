import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, assignJob, type Env } from "@/lib/cartrack";
import { isCompletedOrRejectedStop } from "@/lib/job-filters";
import { driverChoices, loadChoiceInputs, type PickerResult } from "@/lib/psc-driver-choices";
import { pushRunLog } from "@/lib/smart-log-kv";
import { parseVnTimestamp, vnDate, vnTimestamp } from "@/lib/time";
import type { Stop } from "@/lib/types";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

/**
 * Branch-triggered driver change: hand a trip that has not been collected yet to another
 * driver whose roster row covers the time the trip was requested, ±10 minutes.
 *
 * Nothing here runs automatically. The engine keeps assigning by roster; this fires only
 * when a person at the branch decides this one trip should go to someone else.
 */

/** The trip, plus the stops every guard below turns on. */
async function loadJob(jobId: number, env: Env) {
  const res = await fetch(`${BASE_URL}/jobs/${jobId}`, { headers: getHeaders(env), cache: "no-store" });
  if (!res.ok) return null;
  const data = (await res.json())?.data;
  if (!data) return null;
  const stops: Stop[] = data.stops ?? [];
  return {
    data,
    pickup: stops.find((s) => s.stop_type_id === 1) ?? null,
    dropoff: stops.find((s) => s.stop_type_id === 2) ?? null,
  };
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

/** Loads the job, applies the guards, and resolves today's roster for its route. */
async function choicesForJob(jobId: number, env: Env): Promise<NextResponse | { job: NonNullable<Awaited<ReturnType<typeof loadJob>>>; choices: PickerResult }> {
  // Started first: the roster reads do not need the trip, so they overlap its fetch.
  const inputs = loadChoiceInputs(env);
  const job = await loadJob(jobId, env);
  if (!job) return NextResponse.json({ error: "Không tìm thấy chuyến" }, { status: 404 });
  const blocked = blockingReason(job.data.job_status_id ?? null, job.pickup);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });
  if (!job.pickup?.customer_id || !job.dropoff?.customer_id) {
    return NextResponse.json({ error: "Chuyến không có điểm lấy hoặc điểm giao" }, { status: 409 });
  }
  // The request time, not now: a trip booked at 12:00 belongs to the 11:50–12:10 roster.
  const requested = parseVnTimestamp(job.data.create_ts?.slice(0, 19));
  const choices = driverChoices(
    await inputs, job.pickup.customer_id, job.dropoff.customer_id,
    Number.isNaN(requested.getTime()) ? new Date() : requested,
    job.data.delivery_driver_id ?? null,
  );
  return { job, choices };
}

const badId = (v: number) => !Number.isInteger(v) || v <= 0;

/**
 * GET ?pickup=&dropoff=&at=HH:mm — the list to pick from. Built from what the card
 * already shows rather than a fresh fetch of the trip: that fetch was the slowest part
 * of opening the list, and the POST re-checks the real trip before anything changes.
 * The page leaves out the driver the trip already has.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const env = (sp.get("env") ?? "prod") as Env;
  const pickup = sp.get("pickup") ?? "";
  const dropoff = sp.get("dropoff") ?? "";
  const at = sp.get("at") ?? "";
  if (!pickup || !dropoff) return NextResponse.json({ error: "Thiếu tuyến" }, { status: 400 });
  const requested = /^\d{2}:\d{2}$/.test(at) ? parseVnTimestamp(`${vnDate()} ${at}:00`) : new Date();
  try {
    const choices = driverChoices(await loadChoiceInputs(env), pickup, dropoff, requested);
    return NextResponse.json(choices, { headers: { "Cache-Control": "no-store" } });
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
    if (badId(jobId)) return NextResponse.json({ error: "Thiếu mã chuyến" }, { status: 400 });
    if (!/^[0-9a-f-]{36}$/i.test(driverId)) {
      return NextResponse.json({ error: "Giao Nhận Mẫu không hợp lệ" }, { status: 400 });
    }

    // Re-checked at the moment of the change, not merely when the list was drawn. A branch
    // can sit on that screen for minutes, and the driver they tap may have gone on leave.
    const out = await choicesForJob(jobId, env);
    if (out instanceof NextResponse) return out;
    const pick = out.choices.drivers.find((d) => d.driver_id === driverId);
    if (!pick) {
      return NextResponse.json(
        { error: out.choices.reason === "no_driver" || !out.choices.reason
            ? "Giao Nhận Mẫu này không còn trong danh sách, vui lòng chọn lại"
            : "Chưa đọc được lịch phân công, vui lòng thử lại" },
        { status: 409 },
      );
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
      msg: `Job ${jobId} - Chi nhánh đổi Giao Nhận Mẫu sang ${pick.name} | ${out.job.data.reference_number ?? ""}`,
    }]).catch(() => {});

    return NextResponse.json({ success: true, job_id: jobId, driver_id: driverId, driver_name: pick.name });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
