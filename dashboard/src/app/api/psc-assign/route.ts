import { NextRequest, NextResponse, after } from "next/server";
import { BASE_URL, getHeaders, completeJob, createJob, getJobDetails, type Env } from "@/lib/cartrack";
import { driverDisplayName } from "@/lib/job-detail";
import { vnDate, vnHoursMinutes, vnTimestamp } from "@/lib/time";
import { isBlockingPickupStop, isStopStarted, isCompletedOrRejectedStop, pscPairKey } from "@/lib/job-filters";
import { PSC_VIA_LABEL } from "@/lib/via-legs";
import { acquireCreateLock, releaseCreateLock, markPscPair, unmarkPscPair, lookupPscPair, setInstantAssign, getInstantAssign, type PscDupHit } from "@/lib/smart-log-kv";
import { blockedPair, jobIsDone, slimJob } from "@/lib/day-snapshot";
import type { Stop } from "@/lib/types";
import { assignJob } from "@/lib/cartrack";
import { loadConfigFromSheets } from "@/lib/config";
import { loadLeaveEntries } from "@/lib/leave-config";
import { resolveFixedDriver } from "@/lib/fixed-driver";
import { getArmState, pushRunLog } from "@/lib/smart-log-kv";
import type { LogEntry } from "@/lib/types";

export const runtime = "nodejs";
export const preferredRegion = "sin1";
// The instant assign below runs in after(), i.e. against THIS function's budget.
// Without a declared ceiling a slow Cartrack assign can be cut off mid-write.
export const maxDuration = 60;

// In-memory dedup lock: prevents race condition when two tabs submit within seconds of each other.
// Key = `${pickup}-${dropoff}-${today}`, value = timestamp when lock was set.
// Lock expires after 15s — long enough to cover Cartrack job creation + indexing delay.
const creationLock = new Map<string, number>();
const LOCK_TTL_MS = 15_000;

function acquireLock(key: string): boolean {
  const ts = creationLock.get(key);
  if (ts !== undefined && Date.now() - ts < LOCK_TTL_MS) return false;
  creationLock.set(key, Date.now());
  return true;
}

function releaseLock(key: string): void {
  creationLock.delete(key);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchJobsToday(status: number, from: string, to: string, env: Env): Promise<any[]> {
  const params = new URLSearchParams({
    "filter[create_ts_from]": from,
    "filter[create_ts_to]": to,
    "filter[job_status_id]": String(status),
    limit: "1000",
  });

  const res = await fetch(`${BASE_URL}/jobs?${params}`, {
    headers: getHeaders(env),
    cache: "no-store",
  });

  if (!res.ok) return [];
  const data = await res.json();
  return data.data ?? [];
}

/**
 * Live duplicate check — the fallback used only when the day snapshot is unavailable
 * (Redis down, or Cartrack's timeline failing). Fetches today's Assign-Later (2) and
 * Assigned (4) jobs and scans for an active pickup at this location with a matching
 * dropoff. Same predicate the snapshot bakes into its pair index, so the two paths
 * can't reach different verdicts about the same day.
 */
async function liveDuplicateCheck(
  pickup: string, dropoff: string, today: string, env: Env,
): Promise<PscDupHit | null> {
  const todayStart = `${today} 00:00:00`;
  const todayEnd   = `${today} 23:59:59`;

  // Only statuses 2 + 4 can block re-booking; fetch both in parallel.
  const [unassignedJobs, assignedJobs] = await Promise.all([
    fetchJobsToday(2, todayStart, todayEnd, env),
    fetchJobsToday(4, todayStart, todayEnd, env),
  ]);

  // Block if a pickup stop is active (Created/En Route/Arrived) AND a dropoff matches.
  // Allow re-booking once the pickup stop is Completed (4) or Rejected (5) — or carries
  // a completion timestamp while the status still lags, see isBlockingPickupStop — or the
  // job was cancelled (7) / failed (3). Via-legs are intentional double-coverage.
  // (job/stop inferred from the any[] fetch results — no explicit annotation needed.)
  const duplicate = [...unassignedJobs, ...assignedJobs].find((job) => {
    if (job.job_status_id === 7 || job.job_status_id === 3) return false;
    if ((job.labels ?? []).includes(PSC_VIA_LABEL)) return false;
    const stops: Stop[] = job.stops ?? [];
    const hasActivePickup = stops.some((s) =>
      s.stop_type_id === 1 && s.customer_id === pickup && isBlockingPickupStop(s),
    );
    const hasMatchingDropoff = stops.some((s) =>
      s.stop_type_id === 2 && s.customer_id === dropoff,
    );
    return hasActivePickup && hasMatchingDropoff;
  });

  return duplicate
    ? { job_id: duplicate.job_id, reference_number: duplicate.reference_number ?? null }
    : null;
}

/**
 * Re-read one job live and re-test the blocking predicate. Returns false when the job
 * no longer blocks — its pickup has been collected, it was cancelled, or the pair no
 * longer matches — in which case the branch is free to send its next batch.
 *
 * A fetch failure returns true (keep blocking): a request we cannot verify is safer
 * refused than allowed, since the cost of a wrong "no" is a phone call and the cost of
 * a wrong "yes" is a duplicate trip.
 */
async function stillBlocking(hit: PscDupHit, pickup: string, dropoff: string, env: Env): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/jobs/${hit.job_id}`, { headers: getHeaders(env), cache: "no-store" });
    if (!res.ok) return true;
    const job = (await res.json())?.data;
    if (!job) return true;
    if (job.job_status_id === 7 || job.job_status_id === 3) return false;
    const stops: Stop[] = job.stops ?? [];
    const blockingPickup = stops.some(
      (s) => s.stop_type_id === 1 && s.customer_id === pickup && isBlockingPickupStop(s),
    );
    const matchingDropoff = stops.some((s) => s.stop_type_id === 2 && s.customer_id === dropoff);
    return blockingPickup && matchingDropoff;
  } catch {
    return true;
  }
}

/** GET ?job_id= — who the trip just booked was handed to, if anyone yet.
 *  One small Redis read, no Cartrack call: the branch already knows the job id, and
 *  the assignment that happened seconds ago left its note there. Answers null while
 *  the background assign is still running, or when nothing was assigned at all. */
export async function GET(req: NextRequest) {
  const jobId = Number(req.nextUrl.searchParams.get("job_id"));
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: "Thiếu mã chuyến" }, { status: 400 });
  }
  const who = await getInstantAssign(jobId);
  return NextResponse.json({ job_id: jobId, driver_name: who?.driver_name ?? null });
}

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  let lockKey: string | null = null;
  const _t0 = Date.now();
  const plog = (m: string) => console.log(`[VN ${vnTimestamp()}] [psc-assign] ${m}`);

  try {
    const body = await req.json();
    const { psc_pickup, dropoff_location, pickup, dropoff, via_pickup_name } = body;

    if (!pickup || !dropoff || !psc_pickup) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const today = vnDate();
    lockKey = `psc:${pickup}-${dropoff}-${today}`;

    if (!acquireLock(lockKey)) {
      return NextResponse.json(
        // Covers both reasons this lock can be held: a request genuinely in flight right
        // now, and one created up to CREATE_LOCK_TTL_SEC ago whose job Cartrack has not
        // finished indexing. "Đợi vài giây" was only ever true for the first, and the lock
        // now runs to 120s — a branch told to wait a few seconds for two minutes rings
        // the office. Point them at the feed, where the trip is real.
        { error: "duplicate", message: "Yêu cầu cho tuyến này vừa được ghi nhận. Vui lòng kiểm tra danh sách chuyến bên dưới trước khi gửi lại." },
        { status: 409 }
      );
    }

    // Cross-instance guard: the in-memory lock above only covers this one serverless
    // instance. This atomic Redis lock serializes concurrent requests for the same
    // pickup→dropoff across ALL instances, closing the check-then-create race that let
    // two near-simultaneous requests both pass dedup and create duplicate jobs. Held
    // until expiry on success; released on failure / cancel.
    if (!(await acquireCreateLock(lockKey))) {
      releaseLock(lockKey);
      return NextResponse.json(
        // Covers both reasons this lock can be held: a request genuinely in flight right
        // now, and one created up to CREATE_LOCK_TTL_SEC ago whose job Cartrack has not
        // finished indexing. "Đợi vài giây" was only ever true for the first, and the lock
        // now runs to 120s — a branch told to wait a few seconds for two minutes rings
        // the office. Point them at the feed, where the trip is real.
        { error: "duplicate", message: "Yêu cầu cho tuyến này vừa được ghi nhận. Vui lòng kiểm tra danh sách chuyến bên dưới trước khi gửi lại." },
        { status: 409 }
      );
    }

    // --- Duplicate check ---
    // Reads the same day snapshot the branch's own feed renders, so the two can't
    // disagree about whether a trip has left. Falls back to a live fetch when the day
    // is unavailable, so correctness never depends on the cache.
    const _tDup = Date.now();
    const pairKey = pscPairKey(pickup, dropoff);
    // Two sources, one round of latency. The snapshot is the day as the assign cycle last
    // published it — cheap, but up to GUARD_MAX_AGE_MS behind. The overlay is every pair
    // THIS APP has booked, written the instant it was booked, which is precisely what the
    // snapshot cannot yet know about. Reading both is what makes the cheap snapshot safe:
    // a booking from 30 seconds ago is missing from one and present in the other.
    const [overlayHit, lookup] = await Promise.all([
      lookupPscPair(today, pairKey),
      blockedPair(today, env, pairKey),
    ]);
    // The overlay names any pair THIS APP booked today, which is what makes the cheap
    // snapshot safe. But it keeps naming that trip long after the samples have gone, and
    // every later booking for the same route then paid a live job fetch to rediscover
    // that. On 2026-08-18 that fetch was costing 4-12s of a branch's submit — measured
    // across a morning of real bookings, it was the entire wait, with the trip creation
    // itself only ~250ms.
    //
    // The published day can answer it for free. Its blocking-pair index is built from
    // the same predicate the live re-check applies, so if the day was rebuilt AFTER this
    // pair was booked and does not list it, the day has already looked at that trip and
    // found it no longer blocking. Trusting it needs the "after" to be real: a snapshot
    // older than the booking simply has not seen it, and treating that as clearance is
    // how two drivers get sent for one box.
    // Ask the stored day about the exact trip the overlay names. A collected pickup
    // never uncollects, so an old picture showing the samples gone is as good as a new
    // one — no freshness arithmetic required, which is where the first attempt at this
    // went wrong: it demanded a day rebuilt AFTER the booking, and almost nothing
    // qualified. Only the "still blocking" answer is time-sensitive, and that one still
    // falls through to the live check below.
    const clearedByDay =
      overlayHit != null && (await jobIsDone(today, env, overlayHit.job_id)) === true;

    const candidate = clearedByDay
      ? null
      : overlayHit ?? (lookup ? lookup.hit : await liveDuplicateCheck(pickup, dropoff, today, env));
    plog(`dup-check: ${Date.now() - _tDup}ms (${clearedByDay ? "cleared-by-day" : overlayHit ? "overlay" : lookup ? `snapshot age=${lookup.ageMs}ms` : "live-fetch"})`);
    if (clearedByDay) {
      // Same self-heal as the stale-block path below: drop the entry the day has
      // already superseded, so this pair stops being asked about at all.
      void unmarkPscPair(today, pairKey).catch(() => {});
    }

    // Never refuse a branch on a cached reading. A snapshot up to GUARD_MAX_AGE_MS old —
    // or an overlay entry whose trip has since been collected — can still name a job that
    // no longer blocks anything. That is exactly how D006 was told to wait for samples
    // already on their way to D001. Confirming costs one job fetch and only happens on the
    // rare path where we are about to say no.
    const duplicate = candidate && (await stillBlocking(candidate, pickup, dropoff, env)) ? candidate : null;
    if (candidate && !duplicate) {
      plog(`dup-check: stale block on job ${candidate.job_id} — pickup already done, allowing`);
      // Self-heal: drop the overlay entry that just cost a live fetch, so the NEXT booking
      // for this pair doesn't pay for the same discovery again.
      await unmarkPscPair(today, pairKey).catch(() => {});
    }

    if (duplicate) {
      releaseLock(lockKey);
      void releaseCreateLock(lockKey);
      return NextResponse.json(
        {
          error: "duplicate",
          message: `A job for this pickup already exists today (Job #${duplicate.job_id})`,
          job_id: duplicate.job_id,
          reference_number: duplicate.reference_number ?? null,
        },
        { status: 409 }
      );
    }

    // --- Create the job ---
    // Always generate timestamp-based reference (ignore ref_number from config — Cartrack strips emoji)
    const { hours, minutes } = vnHoursMinutes();
    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    const refLabel = `${psc_pickup.replace(/^BRA\s*-\s*/i, "")}→${dropoff_location.replace(/^BRA\s*-\s*/i, "")}_${hh}:${mm}`;

    // Via-route (e.g. D007/D004 stopping by D046): remind the driver to also grab the via PSC's
    // inbound box at this pickup, to hand over informally when passing through the via PSC.
    const pickupTodos = [
      { todo_type_id: 2, description: "📦 Chụp thấy rõ mẫu đã đóng gói trong hộp" },
      { todo_type_id: 2, description: "✍️ Chụp batchsheet đã ký" },
    ];
    if (via_pickup_name) {
      pickupTodos.push({
        todo_type_id: 2,
        description: `📦 Lấy thêm hộp vật tư/tài liệu của ${via_pickup_name} để giao dọc đường`,
      });
    }

    const jobPayload = {
      job_type_id: 1,
      schedule_type_id: 1,
      reference_number: refLabel,
      labels: ["🛵 Vận chuyển mẫu PSC"],
      stops: [
        {
          stop_type_id: 1,
          customer_id: pickup,
          duration: 5,
          todos: pickupTodos,
        },
        {
          stop_type_id: 2,
          customer_id: dropoff,
          duration: 10,
          todos: [
            { todo_type_id: 2, description: "📋 Chụp các hộp thấy rõ batchsheet" },
            { todo_type_id: 2, description: "🤝 Chụp phiếu bàn giao & hàng mang về" },
          ],
        },
      ],
      items: [
        {
          description: "🧪 Mẫu",
          weight: 0,
          item_type_id: 1,
          quantity: 1,
          tracking_number: "",
          todos: [
            { todo_type_id: 3, stop_type_id: 1, is_required: true, description: "🔍 Quét mọi batchsheet" },
            { todo_type_id: 5, stop_type_id: 2, is_required: true, description: "👤 Người nhận" },
          ],
        },
      ],
    };

    const _tCreate = Date.now();
    const createRes = await createJob(jobPayload, env);

    if (!createRes.ok) {
      releaseLock(lockKey);
      void releaseCreateLock(lockKey); // creation failed → free the pair to retry
      return NextResponse.json({ error: "Failed to create job", details: createRes.body }, { status: createRes.status });
    }

    const created = createRes.body;
    const newJobId = created.data?.job_id;
    plog(`job-create: ${Date.now() - _tCreate}ms via=${createRes.via} | total: ${Date.now() - _t0}ms | job_id=${newJobId}`);

    // The day we just changed is stale by definition, so drop its freshness stamp and
    // the next read rebuilds — this branch's own feed reload, or the next request for
    // this pair, sees the new job immediately.
    // AWAITED, not fired and forgotten. This is the note that tells every later reader the
    // cached day is out of date, and it is ~10ms. Dropped, the branch's own reload can be
    // served the pre-booking day — their new trip simply missing from the list — which
    // reads as "the booking failed" and gets a second driver sent for the same samples.
    // Record the pair so the guard sees this trip immediately, without anyone rebuilding
    // the day. This replaces the old invalidateSnapshot call: that made the NEXT reader --
    // any of 40-odd branches -- pay a ~3s fleet-wide rebuild because one branch booked a
    // trip they cannot see. Awaited: dropping it reopens exactly the window it closes.
    if (newJobId) {
      await markPscPair(today, pairKey, { job_id: newJobId, reference_number: refLabel }).catch(() => {});
    }

    // Still deliberately NOT releasing the cross-instance create lock. Invalidating the
    // snapshot makes the day rebuild on the next read, but a rebuild only helps once
    // Cartrack itself lists the new job — and it does not index one instantly. In that
    // gap a second request would rebuild, still not see this job, and create a twin.
    // The lock covers exactly that window; it self-expires, and the cancel/3PL handlers
    // release it early so a cleared trip can be re-requested at once.
    // ── Hand the trip to its driver now, not at the next engine cycle ─────────
    // Runs AFTER the branch's response is sent, so nothing here can slow a booking
    // down or fail one. That is the whole reason the driver is not baked into the
    // create above: Cartrack rejects a create it dislikes outright (verified on prod
    // — 422, no job at all), so a driver it refuses would become a failed booking on
    // the branch's phone. Assigning afterwards can only leave the trip unassigned,
    // which is exactly today's behaviour.
    //
    // A fixed-roster pickup resolves to its driver from config alone, and the cycle
    // reads jobTime from the create timestamp — so this is the same driver the cycle
    // would pick minutes later. Only the moment moves, never the outcome.
    //
    // Every uncertain case deliberately does nothing and lets the engine handle it:
    // an on-shift smart pool (ranked live against driver positions, which config
    // cannot answer), nobody or two drivers on duty, leave with no substitute, a
    // leave sheet that failed to load, the engine disarmed, or a driver Cartrack
    // refuses. Silence here is a working state, not a dropped trip.
    if (newJobId) {
      const jobId: number = newJobId;
      after(async () => {
        const rlog = (msg: string, level: LogEntry["level"] = "OK") =>
          pushRunLog([{ ts: vnTimestamp(), level, msg }]).catch(() => {});
        try {
          // Disarmed means a supervisor switched the engine off on purpose. Assigning
          // anyway would be the one thing that switch is supposed to prevent.
          if (!(await getArmState())) return;

          const [config, leaveEntries] = await Promise.all([
            loadConfigFromSheets(),
            // A leave sheet we could not read is NOT an empty leave sheet. Guessing
            // here sends a trip to someone who is on leave; waiting for the cycle
            // costs a couple of minutes.
            loadLeaveEntries().catch(() => null),
          ]);
          if (!config || !leaveEntries) return;

          const who = resolveFixedDriver(config, pickup, new Date(), leaveEntries);
          if (!who) return;

          const res = await assignJob(who.driverId, jobId, env);
          const label = who.name ?? who.driverId;
          const sub = who.subFor ? ` (trực thay ${who.subFor})` : "";
          if (res.status === 200) {
            rlog(`Job ${jobId} - Giao ngay cho ${label}${sub} | ${refLabel}`);
            // Tell the branch who is coming. Their screen is showing a trip they made
            // seconds ago from their own device; without this they watch "chờ điều phối"
            // for minutes while a driver is already on the way.
            await setInstantAssign(jobId, { driver_id: who.driverId, driver_name: label });
          } else {
            // Whatever Cartrack's reason, the handling is the same: the trip stays
            // unassigned and the next cycle deals with it, exactly as today.
            rlog(`Job ${jobId} - Giao ngay thất bại (${res.status}), chờ chu kỳ | ${refLabel}`, "ERROR");
          }
        } catch (e) {
          rlog(`Job ${jobId} - Giao ngay lỗi: ${String(e).slice(0, 120)}, chờ chu kỳ | ${refLabel}`, "ERROR");
        }
      });
    }

    return NextResponse.json({
      success: true,
      reference: refLabel,
      job_id: newJobId,
    });
  } catch (e) {
    if (lockKey) {
      releaseLock(lockKey);
      void releaseCreateLock(lockKey);
    }
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── DELETE /api/psc-assign?job_id=123 — cancel a PSC trip (only if pickup not started) ──
// Mirrors the PSC-tỉnh cancel: refuse once the driver has touched the pickup, otherwise
// force-cancel and clear the dedup index so the same pickup→dropoff can be re-requested.
export async function DELETE(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  const jobId = req.nextUrl.searchParams.get("job_id");
  if (!jobId) return NextResponse.json({ error: "Missing job_id" }, { status: 400 });

  try {
    const headers = getHeaders(env);

    const jobRes = await fetch(`${BASE_URL}/jobs/${jobId}`, { headers, cache: "no-store" });
    if (!jobRes.ok) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    const jobData = await jobRes.json();
    const stops: Stop[] = jobData.data?.stops ?? [];
    const pickup  = stops.find((s) => s.stop_type_id === 1);
    const dropoff = stops.find((s) => s.stop_type_id === 2);

    // Refuse once the driver has touched the pickup (en route / arrived / completed).
    // isStopStarted also catches the case where status still reads 1 but an activity
    // timestamp is set.
    if (pickup && isStopStarted(pickup)) {
      return NextResponse.json({ error: "Không thể huỷ: Giao Nhận Mẫu đã bắt đầu công việc." }, { status: 409 });
    }

    const res = await fetch(`${BASE_URL}/jobs/${jobId}?force=true`, { method: "DELETE", headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json({ error: "Failed to cancel job", details: err }, { status: res.status });
    }

    // Clear both dedup guards so the same pickup→dropoff can be re-requested at once
    // instead of colliding with the just-cancelled job: rebuild the day on next read
    // and release the cross-instance create lock. Awaited for the same reason as the
    // create path — a lost note leaves the cancelled trip on the branch's screen.
    if (pickup?.customer_id && dropoff?.customer_id) {
      // Free the pair on both guards, or the branch is refused over a trip that is gone.
      await unmarkPscPair(vnDate(), pscPairKey(pickup.customer_id, dropoff.customer_id)).catch(() => {});
      void releaseCreateLock(`psc:${pickup.customer_id}-${dropoff.customer_id}-${vnDate()}`);
    }

    // job_id echoed back so the branch's list can drop this trip locally. A cancelled job
    // leaves the feed entirely (status 7 is not in ALL_STATUSES), so removing it client-
    // side produces exactly what a reload would have — without the reload.
    return NextResponse.json({ success: true, job_id: Number(jobId) });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── PUT /api/psc-assign — hand off to a ride-hailing courier (Grab/Be/XanhSM/Ahamove) ──
// Body: { job_id, batch_ids: string[] }. Assigns the ride-hailing proxy driver, attaches
// each Batch ID as an item tracking_number, then force-completes the trip. Only valid
// while the pickup hasn't been started. Clears the dedup guards on success so the same
// pickup→dropoff can be re-requested immediately.

const GRAB_DRIVER_ID = "6437bace-6578-11f1-9378-fa163ee8d8ac";
const BATCH_ID_RE = /^B\d+$/;

export async function PUT(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  try {
    const body = await req.json();
    const jobId = Number(body?.job_id);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return NextResponse.json({ error: "Job ID không hợp lệ" }, { status: 400 });
    }

    const rawBatchIds: unknown = body?.batch_ids;
    const batchIds = Array.isArray(rawBatchIds)
      ? rawBatchIds.map((b) => String(b).trim()).filter(Boolean)
      : [];
    if (batchIds.length === 0) {
      return NextResponse.json({ error: "Thiếu mã Batch" }, { status: 400 });
    }
    const invalid = batchIds.filter((b) => !BATCH_ID_RE.test(b));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: `Mã Batch không hợp lệ (phải dạng B + số): ${invalid.join(", ")}` },
        { status: 400 }
      );
    }

    const headers = getHeaders(env);

    // Guard: job must exist, not be terminal, and the pickup must not have started.
    const jobRes = await fetch(`${BASE_URL}/jobs/${jobId}`, { headers, cache: "no-store" });
    if (!jobRes.ok) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    const jobData = await jobRes.json();
    const statusId: number | null = jobData.data?.job_status_id ?? null;
    if (statusId === 5) {
      return NextResponse.json({ error: "Chuyến đã hoàn thành rồi" }, { status: 409 });
    }
    if (statusId === 3 || statusId === 7) {
      return NextResponse.json({ error: "Chuyến đã huỷ/thất bại" }, { status: 409 });
    }
    const stops: Stop[] = jobData.data?.stops ?? [];
    const pickup  = stops.find((s) => s.stop_type_id === 1);
    const dropoff = stops.find((s) => s.stop_type_id === 2);
    // Block only when pickup is fully completed or rejected — allow En Route (2) and Arrived (3).
    if (pickup && isCompletedOrRejectedStop(pickup.stop_status_id ?? 0)) {
      return NextResponse.json({ error: "Không thể gửi: tài xế đã hoàn thành lấy mẫu." }, { status: 409 });
    }

    // Assign the proxy driver + attach Batch IDs as item tracking numbers (partial update).
    const updateRes = await fetch(`${BASE_URL}/jobs/${jobId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        delivery_driver_id: GRAB_DRIVER_ID,
        items: batchIds.map((b) => ({
          description: "🧪 Mẫu",
          weight: 0,
          item_type_id: 1,
          quantity: 1,
          tracking_number: b,
        })),
      }),
    });
    if (!updateRes.ok) {
      const err = await updateRes.json().catch(() => ({}));
      return NextResponse.json(
        { error: "Gán tài xế / mã Batch thất bại", details: err },
        { status: 502 }
      );
    }

    // Force-complete the trip.
    const completeRes = await completeJob(jobId, env);
    if (!completeRes.ok) {
      return NextResponse.json(
        { error: "Hoàn thành chuyến thất bại", status: completeRes.status, details: completeRes.body },
        { status: 502 }
      );
    }

    // Pickup→dropoff is fulfilled — clear both dedup guards so a fresh batch can be
    // re-requested at once instead of colliding with the just-completed job. Awaited:
    // a lost note leaves the handed-off trip looking un-handed-off to the branch.
    if (pickup?.customer_id && dropoff?.customer_id) {
      // Free the pair on both guards, or the branch is refused over a trip that is gone.
      await unmarkPscPair(vnDate(), pscPairKey(pickup.customer_id, dropoff.customer_id)).catch(() => {});
      void releaseCreateLock(`psc:${pickup.customer_id}-${dropoff.customer_id}-${vnDate()}`);
    }

    // Hand back the trip as it now stands, so the branch's list can be updated from this
    // response instead of re-reading the whole network's day to learn about one job. One
    // job fetch (~100ms) in place of a ~5s rebuild, and it carries the real
    // activity_completed_ts that the "Đã gửi qua…" line prints — which the client would
    // otherwise have to invent. Best-effort: if the read-back fails the client keeps what
    // it has and the next feed load corrects it. A handoff that succeeded is never
    // reported as failed over a cosmetic re-read.
    const after = await getJobDetails(jobId, env).catch(() => null);
    const job = after?.data ? slimJob(after.data, driverDisplayName(after.data.driver)) : null;

    return NextResponse.json({ success: true, job_id: jobId, job });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
