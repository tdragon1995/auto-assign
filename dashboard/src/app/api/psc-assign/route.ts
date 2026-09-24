import { NextRequest, NextResponse } from "next/server";
import { BASE_URL, getHeaders, completeJob, createJob, getJobDetails, getJobsByStatusAndDate, getLiveDrivers, type Env } from "@/lib/cartrack";
import { driverDisplayName, stripDriverCode } from "@/lib/job-detail";
import { vnDate, vnHoursMinutes, vnTimestamp } from "@/lib/time";
import { isBlockingPickupStop, isStopStarted, isCompletedOrRejectedStop, pscPairKey } from "@/lib/job-filters";
import { PSC_VIA_LABEL } from "@/lib/via-legs";
import { acquireCreateLock, releaseCreateLock, markPscPair, unmarkPscPair, lookupPscPair, type PscDupHit } from "@/lib/smart-log-kv";
import { blockedPair, jobIsDone, slimJob } from "@/lib/day-snapshot";
import type { Job, Stop } from "@/lib/types";
import { loadConfigFromSheets } from "@/lib/config";
import { loadLeaveEntries } from "@/lib/leave-config";
import { resolveFixedDriver } from "@/lib/fixed-driver";
import { pushRunLog } from "@/lib/smart-log-kv";

export const runtime = "nodejs";
export const preferredRegion = "sin1";
// Creating a trip with its driver is two Cartrack calls in the worst case (a refusal,
// then a driverless retry), so give it room rather than have one cut off mid-write.
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

/**
 * Live duplicate check — the fallback used when the day snapshot cannot answer (Redis
 * down, Cartrack's timeline failing, or another caller holding the rebuild lock).
 * Scans today's Assign-Later (2) and Assigned (4) jobs for an active pickup at this
 * location with a matching dropoff. Same predicate the snapshot bakes into its pair
 * index, so the two paths can't reach different verdicts about the same day.
 *
 * Returns "unavailable" when the day could not be read. A caller must NOT read that as
 * a clear route: it used to, because the fetch it replaced answered a refused request
 * with an empty array, and an empty array is indistinguishable from a quiet morning.
 */
async function liveDuplicateCheck(
  pickup: string, dropoff: string, today: string, env: Env,
): Promise<PscDupHit | null | "unavailable"> {
  let jobs: Job[];
  try {
    // getJobsByStatusAndDate, not a local fetch: it filters on scheduled_delivery_ts
    // (footgun 2 — a create_ts filter silently drops every scheduled job, which is most
    // of what a PSC route is), pages to exhaustion rather than truncating at 1000, and
    // THROWS when Cartrack refuses instead of returning nothing.
    // Only statuses 2 + 4 can block re-booking; fetch both in parallel.
    const [unassignedJobs, assignedJobs] = await Promise.all([
      getJobsByStatusAndDate(2, today, env),
      getJobsByStatusAndDate(4, today, env),
    ]);
    jobs = [...unassignedJobs, ...assignedJobs];
  } catch (e) {
    console.warn(`[psc-assign] live duplicate check failed: ${e instanceof Error ? e.message : String(e)}`);
    return "unavailable";
  }

  // Block if a pickup stop is active (Created/En Route/Arrived) AND a dropoff matches.
  // Allow re-booking once the pickup stop is Completed (4) or Rejected (5) — or carries
  // a completion timestamp while the status still lags, see isBlockingPickupStop — or the
  // job was cancelled (7) / failed (3). Via-legs are intentional double-coverage.
  // (job/stop inferred from the any[] fetch results — no explicit annotation needed.)
  const duplicate = jobs.find((job) => {
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
 *
 * Except a 404: that IS an answer. A job deleted in Cartrack cannot be a duplicate, and
 * the overlay names it until the day ends — on 2026-09-11 a deleted D015→D004 trip kept
 * the branch locked out of its route with "vẫn chưa rời chi nhánh".
 */
async function stillBlocking(hit: PscDupHit, pickup: string, dropoff: string, env: Env): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/jobs/${hit.job_id}`, { headers: getHeaders(env), cache: "no-store" });
    if (res.status === 404) return false;
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

// Every handler here is reached only from the branch QR page, so each write is a PERSON's
// action and is logged as one: "[QR] Chi nhánh …", the same origin-prefix convention as
// [AO], [PSC-tỉnh] and [Sales]. Engine lines never carry a prefix, so the two cannot be
// confused. The trailing " | ref" is what the admin job search reads as the label.
// Awaited by every caller: one Redis LPUSH (~10ms), and a line dropped when the function
// freezes after the response is exactly the trace this exists to keep.
function qrLog(msg: string): Promise<void> {
  return pushRunLog([{ ts: vnTimestamp(), level: "OK", msg: `[QR] ${msg}` }]).catch(() => {});
}

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;
  let lockKey: string | null = null;
  // Once a create has been sent, a thrown error (timeout) cannot say whether the trip exists.
  let createSent = false;
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
    // Everything the driver decision needs, started HERE so it overlaps the duplicate
    // check instead of queueing behind it. By the time the pair is cleared these have
    // landed, and putting the driver on the trip costs the booking nothing.
    //
    // The engine switch is NOT consulted: the rostered driver is the one the engine would
    // pick anyway, so an off switch only made the trip wait (2026-09-15, D027 sat 6 min).
    const driverPrep = Promise.all([
      // Today's roster or none: a stale-day copy would name yesterday's driver.
      loadConfigFromSheets({ requireCurrentDay: true }).catch(() => null),
      // An unreadable leave sheet is NOT an empty one. Book the trip driverless and let
      // the engine sort it out rather than send someone who is off today.
      loadLeaveEntries().catch(() => null),
      getLiveDrivers(env).catch(() => null),
    ]);

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

    // What the DAY says about this pair, which is a different question from what the
    // overlay says: the overlay names the last trip this app booked, the day names
    // whatever is actually blocking. Memoised — the live fallback behind it is a real
    // fetch, and both the first pass and the re-check below can ask for it.
    let dayHit: PscDupHit | null | "unavailable" | undefined;
    const fromDay = async (): Promise<PscDupHit | null | "unavailable"> =>
      dayHit !== undefined
        ? dayHit
        : (dayHit = lookup ? lookup.hit : await liveDuplicateCheck(pickup, dropoff, today, env));

    // A cleared overlay clears ONE TRIP, not the route. It used to clear the route: the
    // candidate went straight to null and creation followed, so a pair whose morning run
    // was finished could be booked on top of an afternoon trip the overlay had never
    // named — one made in Cartrack directly, or by another branch's request. Ask the day.
    const candidate = clearedByDay ? await fromDay() : (overlayHit ?? (await fromDay()));
    plog(`dup-check: ${Date.now() - _tDup}ms (${clearedByDay ? "cleared-by-day" : overlayHit ? "overlay" : lookup ? `snapshot age=${lookup.ageMs}ms` : "live-fetch"})`);
    if (clearedByDay && overlayHit) {
      // Same self-heal as the stale-block path below: drop the entry the day has
      // already superseded, so this pair stops being asked about at all.
      void unmarkPscPair(today, pairKey, overlayHit.job_id).catch(() => {});
    }

    // Could not read the day at all. Not a clear route — an unanswered question, and the
    // branch is told to retry rather than given a trip nobody checked. Both locks come
    // off because nothing was created, so that retry can proceed at once. The sentence
    // goes in `error`: the branch's page prints that verbatim for anything but a 409.
    //
    // 20 giây is the day-rebuild lock (LOCK_TTL_S): when another request is building the
    // day, that is genuinely how long until the answer exists. The other two ways to get
    // here — Cartrack refusing the job fetch, Redis unreachable — have no such clock, so
    // the second half sends them to a person rather than round the loop again.
    const unverified = () => {
      releaseLock(lockKey!);
      void releaseCreateLock(lockKey!);
      return NextResponse.json(
        { error: "Vui lòng thử lại sau 20 giây — nếu vẫn báo lỗi, liên hệ đội điều phối.", code: "unverified" },
        { status: 503 },
      );
    };
    if (candidate === "unavailable") return unverified();

    // Never refuse a branch on a cached reading. A snapshot up to GUARD_MAX_AGE_MS old —
    // or an overlay entry whose trip has since been collected — can still name a job that
    // no longer blocks anything. That is exactly how D006 was told to wait for samples
    // already on their way to D001. Confirming costs one job fetch and only happens on the
    // rare path where we are about to say no.
    let duplicate = candidate && (await stillBlocking(candidate, pickup, dropoff, env)) ? candidate : null;
    if (candidate && !duplicate) {
      plog(`dup-check: stale block on job ${candidate.job_id} — pickup already done, allowing`);
      // Self-heal: drop the overlay entry that just cost a live fetch, so the NEXT booking
      // for this pair doesn't pay for the same discovery again.
      await unmarkPscPair(today, pairKey, candidate.job_id).catch(() => {});
      // Disproving ONE suspect is not clearing the route, for the same reason the
      // cleared-overlay path above is not. When the suspect came from the overlay the
      // day may still be holding a different trip against this pair, and nothing had
      // asked it. Same memoised read, so a suspect that came from the day costs nothing.
      const second = await fromDay();
      if (second === "unavailable") return unverified();
      if (second && second.job_id !== candidate.job_id) {
        duplicate = (await stillBlocking(second, pickup, dropoff, env)) ? second : null;
      }
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

    // ── Who this trip is for, decided before it is created ────────────────────────
    // The roster answer is pure config — mapping row, shift window, leave, substitute —
    // and the cycle reads a job's time from its creation stamp, so this is the same
    // driver the engine would reach minutes later. Deciding it here means one write
    // instead of two, no window where the trip belongs to nobody, and a name to hand
    // straight back to the branch.
    //
    // The driver is only attached if a live list still shows that account. That list
    // holds active accounts only, which rules out the failure that actually hurts: a
    // trip sitting on a deactivated account, looking healthy, that nobody can open.
    // Break state is deliberately NOT consulted — a driver on break still gets the trip
    // and picks it up when they return, and the branch can move it with "Đổi giao
    // nhận mẫu" if they cannot wait.
    const [config, leaveEntries, live] = await driverPrep;
    let assignTo: { driverId: string; name: string | null } | null = null;
    // Every path that declines to attach a driver says so. Silence here used to mean a
    // trip quietly waiting ~2 minutes for the engine with nothing to explain it — a real
    // booking (D017, 25/08 17:04) fell back with a healthy roster and a live, logged-in
    // driver, and there was no way to tell which check had refused. One line costs
    // nothing and turns that from a guess into a lookup.
    let skipped: string | null = null;
    if (!config) skipped = "roster unavailable";
    else if (!leaveEntries) skipped = "leave sheet unavailable";
    else {
      const who = resolveFixedDriver(config, pickup, new Date(), leaveEntries, dropoff);
      if (!who) {
        skipped = "roster has no single answer (pool, clash, nobody on duty, or redirected)";
      } else if (!live) {
        // A driver list we could not fetch is not a verdict on the driver. Attach anyway
        // and let the create's own driver check verify — slower, but it keeps a transient
        // fleetweb hiccup from silently turning instant assignment off, which is the most
        // likely explanation for a trip that waits for the cycle with nothing else wrong.
        assignTo = { driverId: who.driverId, name: who.name };
        skipped = null;
        plog("driver list unavailable — attaching anyway, create will verify");
      } else if (!live.some((d) => d.deliveryDriverId === who.driverId)) {
        // Absent from a list of ACTIVE accounts. This is the one worth refusing over: a
        // trip on a deactivated account looks healthy and nobody ever opens it.
        skipped = `driver ${who.name ?? who.driverId} is not an active account`;
      } else {
        assignTo = { driverId: who.driverId, name: who.name };
      }
    }
    if (skipped) plog(`no instant driver: ${skipped}`);

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
      ...(assignTo ? { delivery_driver_id: assignTo.driverId } : {}),
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
    // "ok" skips the create's own driver lookup, and is only honest when a live list has
    // just confirmed the account. Without that list, let the create do its own checking.
    const preVerified = assignTo != null && live != null;
    createSent = true;
    let createRes = await createJob(jobPayload, env, preVerified ? "ok" : undefined);

    // A driver Cartrack will not accept must cost the branch a trip, not a booking. If
    // the create was refused while carrying a driver, make the same trip without one and
    // let the engine place it — which is exactly what used to happen anyway.
    // Only a 4xx is a refusal of the DRIVER. A 5xx — including "RPC said ok but gave no
    // job id" — may have created the trip, and posting again would make its twin.
    if (!createRes.ok && assignTo && createRes.status >= 400 && createRes.status < 500) {
      plog(`create refused with driver (${createRes.status}) — retrying unassigned`);
      const { delivery_driver_id: _dropped, ...driverless } = jobPayload as Record<string, unknown>;
      void _dropped;
      assignTo = null;
      createRes = await createJob(driverless, env);
    }

    if (!createRes.ok && createRes.status >= 500) {
      // Unknown whether a trip exists. Keep BOTH locks (they self-expire) so a quick retap
      // cannot make a second one, and send the branch to the list first.
      plog(`create result ambiguous (${createRes.status}) — holding the pair lock`);
      return NextResponse.json(
        { error: "Chưa xác nhận được yêu cầu. Vui lòng kiểm tra danh sách chuyến bên dưới trước khi gửi lại.", details: createRes.body },
        { status: 502 },
      );
    }

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
    // A branch pressed the button, so the log says a branch did it -- with or without an
    // instant driver. Without this line an unattached booking only surfaced later as the
    // engine's own SMART line, reading as if the system had invented the trip.
    if (newJobId) {
      await qrLog(assignTo
        ? `Chi nhánh tạo chuyến: Job ${newJobId}, giao cho ${assignTo.name ?? assignTo.driverId} | ${refLabel}`
        : `Chi nhánh tạo chuyến: Job ${newJobId}, chờ engine giao | ${refLabel}`);
    }

    if (newJobId) {
      await markPscPair(today, pairKey, { job_id: newJobId, reference_number: refLabel }).catch(() => {});
    }

    // Still deliberately NOT releasing the cross-instance create lock. Invalidating the
    // snapshot makes the day rebuild on the next read, but a rebuild only helps once
    // Cartrack itself lists the new job — and it does not index one instantly. In that
    // gap a second request would rebuild, still not see this job, and create a twin.
    // The lock covers exactly that window; it self-expires, and the cancel/3PL handlers
    // release it early so a cleared trip can be re-requested at once.
    return NextResponse.json({
      success: true,
      reference: refLabel,
      job_id: newJobId,
      // The branch's card reads this directly. Their screen shows a trip made seconds
      // ago from their own device, which the published day will not carry for minutes,
      // so the response is the only place this name can come from in time.
      driver_name: assignTo?.name ? stripDriverCode(assignTo.name) : null,
    });
  } catch (e) {
    if (createSent) {
      // Same as an ambiguous 5xx: keep the locks, point the branch at the list.
      return NextResponse.json(
        { error: "Chưa xác nhận được yêu cầu. Vui lòng kiểm tra danh sách chuyến bên dưới trước khi gửi lại.", details: String(e) },
        { status: 502 },
      );
    }
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
      await unmarkPscPair(vnDate(), pscPairKey(pickup.customer_id, dropoff.customer_id), Number(jobId)).catch(() => {});
      void releaseCreateLock(`psc:${pickup.customer_id}-${dropoff.customer_id}-${vnDate()}`);
    }

    await qrLog(`Chi nhánh huỷ chuyến: Job ${jobId} | ${jobData.data?.reference_number ?? ""}`);

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
      await unmarkPscPair(vnDate(), pscPairKey(pickup.customer_id, dropoff.customer_id), jobId).catch(() => {});
      void releaseCreateLock(`psc:${pickup.customer_id}-${dropoff.customer_id}-${vnDate()}`);
    }

    await qrLog(`Chi nhánh gửi qua 3PL: Job ${jobId}, Batch ${batchIds.join(", ")} | ${jobData.data?.reference_number ?? ""}`);

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
