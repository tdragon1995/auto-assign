import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, completeJob, createJob, type Env } from "@/lib/cartrack";
import { vnDate, vnHoursMinutes, vnTimestamp } from "@/lib/time";
import { isActiveStop, isStopStarted, isCompletedOrRejectedStop, pscPairKey } from "@/lib/job-filters";
import { PSC_VIA_LABEL } from "@/lib/via-legs";
import { lookupPscActivePickup, markPscActivePickup, unmarkPscActivePickup, acquireCreateLock, releaseCreateLock, type PscDupHit } from "@/lib/smart-log-kv";
import type { Stop } from "@/lib/types";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

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
 * Live duplicate check — the fallback used only when the Redis fast-path index is
 * stale/absent (assign engine disarmed). Fetches today's Assign-Later (2) and
 * Assigned (4) jobs and scans for an active pickup at this location with a matching
 * dropoff. Same predicate the assign cycle bakes into the index.
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
  // Allow re-booking once the pickup stop is Completed (4) or Rejected (5), or the
  // job was cancelled (7) / failed (3). Via-legs are intentional double-coverage.
  // (job/stop inferred from the any[] fetch results — no explicit annotation needed.)
  const duplicate = [...unassignedJobs, ...assignedJobs].find((job) => {
    if (job.job_status_id === 7 || job.job_status_id === 3) return false;
    if ((job.labels ?? []).includes(PSC_VIA_LABEL)) return false;
    const stops: Stop[] = job.stops ?? [];
    const hasActivePickup = stops.some((s) =>
      s.stop_type_id === 1 && s.customer_id === pickup && s.stop_status_id != null && isActiveStop(s.stop_status_id),
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
        { error: "duplicate", message: "Yêu cầu cùng chi nhánh đang được tạo!" },
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
        { error: "duplicate", message: "Yêu cầu cùng chi nhánh đang được tạo!" },
        { status: 409 }
      );
    }

    // --- Duplicate check ---
    // Fast path: the assign cycle keeps a Redis index of active pickup→dropoff pairs,
    // so a normal request answers from one tiny read instead of two fleet-wide Cartrack
    // job fetches. Fall back to a live fetch only when the index isn't fresh (engine
    // disarmed / index aged out), so correctness never depends on the cycle running.
    const _tDup = Date.now();
    const pairKey = pscPairKey(pickup, dropoff);
    const { fresh, hit } = await lookupPscActivePickup(pairKey);
    const duplicate = fresh ? hit : await liveDuplicateCheck(pickup, dropoff, today, env);
    plog(`dup-check: ${Date.now() - _tDup}ms (${fresh ? "redis-fast" : "live-fetch"})`);

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

    // Write-through: register the new job in the fast-path index immediately so a
    // re-tap before the next cycle (which would otherwise not yet see this job) is
    // blocked. Fire-and-forget — it must not delay the response.
    if (newJobId) void markPscActivePickup(pairKey, { job_id: newJobId, reference_number: refLabel });

    // Deliberately do NOT release the cross-instance create lock here: holding it to its
    // TTL keeps blocking a duplicate request for this pair while the new job becomes
    // visible to the dedup check. It self-expires, and the cancel handler releases it
    // early so a cancelled trip can be re-requested at once.
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
      return NextResponse.json({ error: "Không thể huỷ: tài xế đã bắt đầu công việc." }, { status: 409 });
    }

    const res = await fetch(`${BASE_URL}/jobs/${jobId}?force=true`, { method: "DELETE", headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json({ error: "Failed to cancel job", details: err }, { status: res.status });
    }

    // Clear both dedup guards so the same pickup→dropoff can be re-requested at once
    // instead of colliding with the just-cancelled job: drop the index pair and release
    // the cross-instance create lock (which is otherwise held to its TTL after a create).
    if (pickup?.customer_id && dropoff?.customer_id) {
      void unmarkPscActivePickup(pscPairKey(pickup.customer_id, dropoff.customer_id));
      void releaseCreateLock(`psc:${pickup.customer_id}-${dropoff.customer_id}-${vnDate()}`);
    }

    return NextResponse.json({ success: true });
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
    // re-requested at once instead of colliding with the just-completed job.
    if (pickup?.customer_id && dropoff?.customer_id) {
      void unmarkPscActivePickup(pscPairKey(pickup.customer_id, dropoff.customer_id));
      void releaseCreateLock(`psc:${pickup.customer_id}-${dropoff.customer_id}-${vnDate()}`);
    }

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
