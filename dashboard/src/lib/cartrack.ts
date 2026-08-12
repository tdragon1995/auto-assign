import { Redis } from "@upstash/redis";
import type { Driver, Job, Stop, TimelineRoute } from "./types";
import { vnDayWindow } from "./time";

export type Env = "prod" | "uat";

export const BASE_URL = "https://fleetapi-vn.cartrack.com/rest/delivery";

export const PROXY_DRIVER_ID = "a8c48608-45d0-11f1-9378-fa163ee8d8ac";

export function getHeaders(env: Env = "prod"): Record<string, string> {
  const suffix = env === "uat" ? "_UAT" : "";
  const auth = process.env[`CARTRACK_AUTH${suffix}`] ?? "";
  const cookie = process.env[`CARTRACK_COOKIE${suffix}`] ?? "";
  if (!auth) throw new Error(`CARTRACK_AUTH${suffix} environment variable not set`);

  const headers: Record<string, string> = {
    Authorization: auth,
    "Content-Type": "application/json",
  };
  if (cookie) headers["Cookie"] = cookie;
  return headers;
}

/**
 * True when a Cartrack job create/assign response means the target driver is
 * on-break or offline — its driver_status_id doesn't allow assignment. Cartrack
 * returns the same `delivery_driver_id` validation message for both states
 * ("...does not exist or the current status..."), so they're indistinguishable here.
 */
export function isDriverUnavailableError(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const ct = (body as Record<string, unknown>).error as Record<string, unknown> | undefined;
  const msgs = (ct?.data as Record<string, unknown> | undefined)?.delivery_driver_id;
  return Array.isArray(msgs) && msgs.some(
    (m: unknown) => typeof m === "string" && m.includes("does not exist or the current status")
  );
}

/**
 * Turn a Cartrack error body into a short, readable reason instead of dumping
 * raw JSON into the log — the { error: { message, data: { field: [...] } } }
 * shape isn't meant for a human reader. Shared by return-trips/via-legs; the
 * main assign loop keeps its own copy (assign.ts, pre-dates this one).
 */
export function friendlyCreateError(body: unknown, max = 180): string {
  if (isDriverUnavailableError(body)) return "driver on-break or offline";
  let text: string;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const ct = b.error as Record<string, unknown> | undefined;
    const ctData = ct?.data as Record<string, unknown> | undefined;
    if (ctData && typeof ctData === "object") {
      text = Object.entries(ctData)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("; ") : String(v)}`)
        .join(" | ");
    } else if (typeof ct?.message === "string" && ct.message.trim()) {
      text = ct.message.trim();
    } else if (typeof b.message === "string" && b.message.trim()) {
      text = b.message.trim();
    } else {
      text = JSON.stringify(body);
    }
  } else {
    text = String(body);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Fetch all assigned jobs for a driver with no date filter.
 *  Used by releaseDueProxyJobs so multi-day parked jobs (created on a previous
 *  day) are still found and released when their send_to_driver_at arrives. */
export async function getAllAssignedDriverJobs(
  driverId: string,
  env: Env = "prod"
): Promise<Job[]> {
  // Paginate to exhaustion — a heavy parked backlog can exceed one page, and a
  // silent truncation would leave parked jobs unreleased. Mirrors getJobsByDate.
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 5;
  const all: Job[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      "filter[job_status_id]": "4",
      page: String(page),
      limit: String(PAGE_SIZE),
      per_page: String(PAGE_SIZE),
    });
    const res = await fetch(`${BASE_URL}/drivers/${driverId}/jobs?${params}`, {
      headers: getHeaders(env),
      cache: "no-store",
    });
    if (!res.ok) return all;
    const data = await res.json();
    const batch: Job[] = data.data ?? [];
    let added = 0;
    for (const j of batch) {
      if (seen.has(j.job_id)) continue;
      seen.add(j.job_id);
      all.push(j);
      added++;
    }
    if (batch.length < PAGE_SIZE || added === 0) break;
  }
  return all;
}

export async function getDrivers(env: Env = "prod"): Promise<Driver[]> {
  const params = new URLSearchParams({ page: "1", limit: "1000" });

  const res = await fetch(`${BASE_URL}/drivers?${params}`, {
    headers: getHeaders(env),
    cache: "no-store",
  });

  if (!res.ok) return [];
  const data = await res.json();

  return (data.data ?? []).map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (d: any): Driver => ({
      delivery_driver_id: d.delivery_driver_id,
      first_name: d.first_name ?? "",
      last_name: d.last_name ?? "",
      last_login_ts: d.last_login_ts,
      is_online: !!d.is_online,
      is_active: !!d.is_active,
      phone_number: d.phone_number,
      latitude: d.latitude ?? null,
      longitude: d.longitude ?? null,
      driver_status_id: d.driver_status_id ?? 4,
      start_location_customer_id: d.start_location_customer_id ?? null,
      shift_time_start: d.shift_time_start ?? null,
    })
  );
}

export async function deleteJob(jobId: number, env: Env = "prod"): Promise<boolean> {
  // Try the fleetweb RPC first — measured ~2s vs ~4.7s REST (2026-07-17), and it
  // deletes jobs created by either path. deletedJobIds echoes the ids actually
  // removed; anything else (error, id absent) falls through to REST for the
  // authoritative answer.
  const out = await jsonRpc<{ deletedJobIds?: Record<string, number> }>(
    "delivery_delete_job",
    { data: { jobIds: [jobId] } },
    { env }
  );
  if (out.ok && out.result?.deletedJobIds?.[jobId] !== undefined) return true;
  const res = await fetch(`${BASE_URL}/jobs/${jobId}?force=true`, {
    method: "DELETE",
    headers: getHeaders(env),
  });
  return res.ok;
}

export async function assignJob(
  driverId: string,
  jobId: number,
  env: Env = "prod",
  driverRec?: Driver
): Promise<{
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}> {
  const viaRpc = await tryAssignViaRpc(jobId, driverId, env, driverRec);
  if (viaRpc.kind === "assigned") {
    return { status: 200, body: { data: { job_id: jobId, delivery_driver_id: driverId } } };
  }
  if (viaRpc.kind === "blocked") return { status: 422, body: viaRpc.body };
  const res = await fetch(`${BASE_URL}/jobs/assign/${driverId}`, {
    method: "PUT",
    headers: getHeaders(env),
    body: JSON.stringify({ job_ids: [jobId] }),
  });
  return { status: res.status, body: await res.json() };
}

/** Assign a driver to an EXISTING job via the update endpoint (PUT /jobs/{id} with
 *  delivery_driver_id). Unlike PUT /jobs/assign/{driver} (which returns an empty body),
 *  this returns the full job INCLUDING the nested `driver` object — so the caller gets
 *  the driver's name from the same call, no getDrivers lookup needed. Verified prod
 *  2026-06-07: flips status 2→4, sets assigned_ts, and the job still reaches the driver
 *  app (send_to_driver_at stays null — that field only governs delayed sending). Use for
 *  single-driver assigns; keep assignJob (reassign) for the smart multi-driver fallback
 *  so its on-break 422 error shape stays intact. */
export async function assignJobViaUpdate(
  jobId: number,
  driverId: string,
  env: Env = "prod",
  driverRec?: Driver
): Promise<{
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  driverName: string | null;
}> {
  const viaRpc = await tryAssignViaRpc(jobId, driverId, env, driverRec);
  if (viaRpc.kind === "assigned") {
    return {
      status: 200,
      body: { data: { job_id: jobId, delivery_driver_id: driverId } },
      driverName: viaRpc.driverName,
    };
  }
  if (viaRpc.kind === "blocked") return { status: 422, body: viaRpc.body, driverName: null };
  const res = await fetch(`${BASE_URL}/jobs/${jobId}`, {
    method: "PUT",
    headers: getHeaders(env),
    body: JSON.stringify({ delivery_driver_id: driverId }),
  });
  const body = await res.json().catch(() => ({}));
  const d = body?.data?.driver;
  const driverName = d ? `${d.first_name ?? ""} ${d.last_name ?? ""}`.trim() || null : null;
  return { status: res.status, body, driverName };
}

/** Force-complete a job. Cartrack's PUT /jobs/{id}/complete acts on the path id only;
 *  the body is ignored, so we send an empty one. Raw status/body returned for diagnosis. */
export async function completeJob(
  jobId: number,
  env: Env = "prod"
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}/jobs/${jobId}/complete`, {
    method: "PUT",
    headers: { ...getHeaders(env), Accept: "application/json" },
    body: JSON.stringify({}),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

export async function getCustomerById(
  customerId: string,
  env: Env = "prod"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ data: any } | null> {
  const res = await fetch(`${BASE_URL}/customers/${customerId}`, {
    headers: getHeaders(env),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

// Partial update — verified: sending only `contact_number` leaves customer_name,
// address and coordinates intact. Never widen this payload to include
// `customer_name`; see the name-corruption note in docs/cartrack-api.md.
export async function updateCustomerPhone(
  customerId: string,
  contactNumber: string,
  env: Env = "prod"
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${BASE_URL}/customers/${customerId}`, {
    method: "PUT",
    headers: getHeaders(env),
    body: JSON.stringify({ contact_number: contactNumber }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true };
}

// Update a customer's address + coordinates.
//
// Unlike contact_number, `address_line_1` is IGNORED by a partial PUT — the API
// returns 200 and silently keeps the old value (verified against prod). It only
// takes when the FULL record is echoed back. So this reads the current record
// and re-PUTs every field with just the address/coords swapped. customer_name is
// preserved from the read, never derived, so the name-corruption footgun cannot
// fire. is_address_locked does NOT block this — the flag can't be set via the API
// and the full PUT writes through regardless (verified prod 2026-07-xx).
export async function updateCustomerAddress(
  customerId: string,
  addr: { address_line_1: string; latitude: number; longitude: number; postal_code?: string },
  env: Env = "prod"
): Promise<{ ok: boolean; error?: string }> {
  const current = await getCustomerById(customerId, env);
  if (!current?.data) return { ok: false, error: "Không đọc được địa điểm hiện tại từ Cartrack" };
  const c = current.data;

  const payload = {
    customer_name: c.customer_name,
    email: c.email,
    contact_code: c.contact_code,
    contact_number: c.contact_number,
    address_line_1: addr.address_line_1,
    address_line_2: c.address_line_2,
    postal_code: addr.postal_code ?? c.postal_code,
    country_id: c.country_id,
    latitude: addr.latitude,
    longitude: addr.longitude,
    client_reference: c.client_reference,
  };

  const res = await fetch(`${BASE_URL}/customers/${customerId}`, {
    method: "PUT",
    headers: getHeaders(env),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  // The API can 200 without applying the address (the exact partial-PUT trap),
  // so confirm by reading back rather than trusting the status.
  const after = await getCustomerById(customerId, env);
  const a = after?.data;
  if (!a) return { ok: true }; // write returned ok; couldn't re-read to confirm
  const landed =
    (a.address_line_1 ?? "") === addr.address_line_1 &&
    Number(a.latitude) === addr.latitude &&
    Number(a.longitude) === addr.longitude;
  if (!landed) {
    return { ok: false, error: "Cartrack nhận yêu cầu nhưng không cập nhật (200 nhưng dữ liệu không đổi)" };
  }
  return { ok: true };
}

/** PUT a job's stops. Pass `jobTypeId` for any job whose stop count doesn't match the
 *  default 2-stop pickup+dropoff shape: Cartrack validates the stops array against the
 *  job type, and without job_type_id in the body it assumes the default and rejects a
 *  valid payload with 422 "The number of stops for this job type is not valid".
 *  Verified against prod: a 1-stop chấm-công job (job_type_id 3) only accepts the PUT
 *  when job_type_id is included. 2-stop callers can safely omit it. */
export async function updateJobStops(
  jobId: number,
  stops: { stop_id: number; stop_type_id: number; customer_id: string; customer_name?: string; note?: string; country_id?: number; delivery_windows?: { time_from: string; time_to: string }[] }[],
  env: Env = "prod",
  jobTypeId?: number
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}/jobs/${jobId}`, {
    method: "PUT",
    headers: getHeaders(env),
    body: JSON.stringify(jobTypeId == null ? { stops } : { job_type_id: jobTypeId, stops }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// DO NOT route stop updates through the `delivery_update_job` JSON-RPC. It exists
// (it's what the fleetweb UI posts), and it is a FULL REPLACE: every field absent
// from the payload is cleared, not preserved.
//
// Measured on a throwaway 2-stop job, prod 2026-07-28, sending only
// {stopId, stopTypeId, customerId} per stop:
//   dropoff todos 3 -> 0        (destroyed)
//   pickup  todos 2 -> 0        (destroyed — that stop wasn't even being changed)
//   dropoff duration 10 -> 5    (reset to default)
// The customer swap itself worked and address/coords/contact resolved correctly
// from the new customer_id, so the call LOOKS successful: it returns no error and
// the swap is visible. The todo loss is silent, and todos are the driver's
// proof-of-delivery steps (photo, e-sign, note).
//
// The REST PUT above is a partial update — it preserves everything not sent — which
// is why the alt-dropoff swap uses it. Matching the RPC would mean echoing back the
// entire stop including todos with their stopTodoId, i.e. rewriting fields we never
// intended to touch, to save well under a second on a once-per-job call.

export async function updateJobSendToDriverAt(
  jobId: number,
  sendToDriverAt: string,
  env: Env = "prod"
): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`${BASE_URL}/jobs/${jobId}`, {
    method: "PUT",
    headers: getHeaders(env),
    body: JSON.stringify({ send_to_driver_at: sendToDriverAt }),
  });
  return { ok: res.ok, status: res.status };
}

export async function updateJobScheduledDeliveryTs(
  jobId: number,
  scheduledDeliveryTs: string, // "YYYY-MM-DD HH:MM:SS"
  env: Env = "prod"
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const datePart = scheduledDeliveryTs.slice(0, 10); // "YYYY-MM-DD"
  // Cartrack requires the timestamps below to be AFTER now. Midnight of the scheduled
  // date is ideal for a future day (driver may start anytime that day), but is in the
  // PAST for a same-day schedule → 422. Clamp to the later of midnight and ~now+2min
  // (both as VN-time "YYYY-MM-DD HH:MM:SS" strings, so a lexical compare is chronological).
  const midnight = `${datePart} 00:00:00`;
  const vnNowPlus = new Date(Date.now() + 7 * 3_600_000 + 2 * 60_000)
    .toISOString().slice(0, 19).replace("T", " ");
  const allowedToStartAt = midnight > vnNowPlus ? midnight : vnNowPlus;
  const res = await fetch(`${BASE_URL}/jobs/${jobId}`, {
    method: "PUT",
    headers: getHeaders(env),
    body: JSON.stringify({
      schedule_type_id: 2,           // Scheduled — required for delivery_windows
      // scheduled_delivery_ts gates mobile-app visibility: Cartrack keeps the job hidden
      // from the driver (is_visible=false) while now <= scheduled_delivery_ts. Pointing it
      // at the window/arrival time therefore hides the job until arrival. Instead use the
      // early clamped value: its DATE is still the delivery day (the assign cycle fetches
      // parked jobs by scheduled_delivery_ts = today), but its time-of-day is day-start, so
      // is_visible flips true at the start of the delivery day — well before the driver is
      // assigned. The real appointment time lives in the stop's delivery_windows.
      scheduled_delivery_ts: allowedToStartAt,
      allowed_to_start_at: allowedToStartAt,
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

export async function unassignJob(
  jobId: number,
  env: Env = "prod",
  driverId?: string
): Promise<{ ok: boolean; status: number }> {
  // Prefer the fleetweb RPC (measured ~2.2s vs ~5.5s REST, 2026-07-18). Verified:
  // the `filter` window is NOT sensitive (a job scheduled another day still
  // unassigns) and the routeId is NOT validated against the job's current driver
  // — the jobIds drive the operation — so a missing/imperfect driver hint can't
  // unassign the wrong job. Confirm the id echoes back in unassignedJobs; anything
  // else falls through to the authoritative REST PUT.
  // Unlike delete, unassign has no driver-state concern (it removes, not adds).
  const out = await jsonRpc<{ unassigned?: { unassignedJobs?: number[] } }>(
    "delivery_route_slice_jobs_unassign",
    {
      data: {
        routeId: `driver_${driverId ?? PROXY_DRIVER_ID}`,
        jobIds: [jobId],
        updateRecurringSetup: false,
        scheduleType: "scheduled",
        filter: vnDayWindow(),
      },
    },
    { env }
  );
  if (out.ok && out.result?.unassigned?.unassignedJobs?.includes(jobId)) {
    return { ok: true, status: 200 };
  }
  const res = await fetch(`${BASE_URL}/jobs/${jobId}`, {
    method: "PUT",
    headers: getHeaders(env),
    body: JSON.stringify({ delivery_driver_id: null }),
  });
  return { ok: res.ok, status: res.status };
}

export const JSONRPC_URL = "https://fleetweb-vn.cartrack.com/jsonrpc/index.php";
const COOKIE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Cookie cache is per-env AND per-process: on Vercel each warm lambda logs in
// once and reuses that session for every JSON-RPC call it makes.
const _cookieCache: Partial<Record<Env, { cookie: string; expiry: number }>> = {};

/** Back-off after Cartrack refuses the credentials. ct_login counts failed attempts
 *  and locks the account (the refusal body carries `attempts_remaining`), while the
 *  assign cycle logs in several times an hour — so a wrong password must not be
 *  retried on every call, or a config mistake becomes a locked production account. */
const LOGIN_BLOCK_MS = 10 * 60 * 1000;
const _loginBlock: Partial<Record<Env, number>> = {};

/**
 * The login currently running, if one is. Concurrent callers await it instead of each
 * starting their own handshake.
 *
 * This matters because nothing in this codebase calls JSON-RPC one at a time. buildSnapshot
 * fires two RPCs at once, return-trips three, the optimise batch five, and the assign loop
 * and proxy release up to ten. They all share one cookie, so when Cartrack drops a session
 * they ALL get the expiry signal in the same instant and jsonRpc retries every one of them
 * with `force`. Without this, that is ten simultaneous logins against an account Cartrack
 * counts attempts on — the same lockout risk the back-off above exists to prevent.
 *
 * It also removes a delete/write race on the shared copy: `force` drops the shared cookie
 * before re-logging in, so ten forced callers meant ten DELETEs interleaving with ten
 * writes, and a cookie one caller had just stored could be deleted by another arriving
 * late. Only the first caller now runs that sequence.
 *
 * Joining an in-flight login is always safe regardless of `force`, because a login always
 * mints a NEW session — a forced caller cannot be handed back the dead cookie it was
 * retrying. What a forced caller must not do is take the SHARED cookie, and it doesn't:
 * that lookup happens before this point and is skipped when force is set.
 */
const _loginInFlight: Partial<Record<Env, Promise<string | null>>> = {};

/**
 * Second tier for both caches above, shared across instances.
 *
 * WHY: the per-process cache only helps a lambda that is already warm. A cold one has an
 * empty object and pays a fresh ct_login — a TLS + auth handshake measured 2026-08-11 at
 * ~280ms of ACTIVE CPU, against ~40-90ms for ALL the parsing and index-building a steady
 * cycle does. That single line plausibly accounts for most of /api/assign/cron's ~305ms
 * per invocation. Redis turns it into a ~2-5ms GET for every instance after the first.
 *
 * The login BLOCK is shared for a sharper reason than cost. Cartrack counts failed
 * attempts and locks the account. A per-process back-off means a wrong password is
 * retried once per cold instance — exactly the "config mistake becomes a locked
 * production account" this back-off exists to prevent, just spread across instances where
 * it is invisible. Sharing it makes the back-off actually global.
 *
 * Best-effort throughout: no Redis, or Redis down, degrades to the per-process behaviour
 * that shipped before this. A cache that cannot be read must never be able to stop a
 * login that would otherwise succeed.
 */
const SHARED_COOKIE_KEY = (env: Env) => `fleetweb:cookie:v1:${env}`;
const SHARED_BLOCK_KEY = (env: Env) => `fleetweb:login_block:v1:${env}`;

function getCookieRedis(): Redis | null {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

type CookieRecord = { cookie: string; expiry: number };

/** One round-trip for both keys — this runs on the path that already missed the local
 *  cache, so it must not cost two. */
async function readShared(env: Env): Promise<{ record: CookieRecord | null; blockedUntil: number }> {
  const redis = getCookieRedis();
  if (!redis) return { record: null, blockedUntil: 0 };
  try {
    const [rawCookie, rawBlock] = await redis.mget<[CookieRecord | string | null, number | string | null]>(
      SHARED_COOKIE_KEY(env), SHARED_BLOCK_KEY(env),
    );
    let record: CookieRecord | null = null;
    if (rawCookie) {
      const parsed = typeof rawCookie === "string"
        ? (JSON.parse(rawCookie) as CookieRecord)
        : rawCookie;
      // Trust the stored expiry over the key's TTL: adopting a shared cookie must not
      // reset a 12h clock that is nearly spent, or the local copy outlives the session.
      if (parsed?.cookie && Date.now() < parsed.expiry) record = parsed;
    }
    return { record, blockedUntil: Number(rawBlock ?? 0) };
  } catch {
    return { record: null, blockedUntil: 0 };
  }
}

async function writeSharedCookie(env: Env, record: CookieRecord): Promise<void> {
  const redis = getCookieRedis();
  if (!redis) return;
  const ttlSec = Math.ceil((record.expiry - Date.now()) / 1000);
  if (ttlSec <= 0) return;
  try {
    await redis.set(SHARED_COOKIE_KEY(env), JSON.stringify(record), { ex: ttlSec });
  } catch { /* best-effort */ }
}

/** Drop the shared session. Called when Cartrack rejects one mid-flight (`force`):
 *  without this, the dead cookie sits in Redis and every OTHER instance adopts it —
 *  turning one expired session into a fleet-wide JSON-RPC outage until the TTL runs out. */
async function dropSharedCookie(env: Env): Promise<void> {
  const redis = getCookieRedis();
  if (!redis) return;
  try { await redis.del(SHARED_COOKIE_KEY(env)); } catch { /* best-effort */ }
}

async function writeSharedBlock(env: Env, until: number): Promise<void> {
  const redis = getCookieRedis();
  if (!redis) return;
  try {
    await redis.set(SHARED_BLOCK_KEY(env), String(until), { ex: Math.ceil(LOGIN_BLOCK_MS / 1000) });
  } catch { /* best-effort */ }
}

/** Login to fleetweb and return a session cookie string, or null on failure.
 *  `force` skips the cache — used by jsonRpc() to re-login when Cartrack rejects
 *  a session before our TTL expects it to. */
export async function getFleetwebCookie(env: Env = "prod", force = false): Promise<string | null> {
  const cached = _cookieCache[env];
  if (!force && cached && Date.now() < cached.expiry) return cached.cookie;

  // Local cache missed. Ask the shared one before paying for a handshake — this is the
  // whole point of the second tier, and it is where a cold instance saves ~280ms of CPU.
  // Read even under `force`, because the BLOCK still applies; only the cookie is ignored.
  const shared = await readShared(env);
  if (shared.blockedUntil > Date.now()) {
    // Another instance has already been refused by Cartrack. Adopt the back-off instead of
    // spending one of the account's remaining attempts rediscovering it.
    _loginBlock[env] = shared.blockedUntil;
    return null;
  }
  if (!force && shared.record) {
    _cookieCache[env] = shared.record; // carry the ORIGINAL expiry, not a fresh 12h
    return shared.record.cookie;
  }

  // Honoured even under `force`: force exists to replace an expired SESSION, and
  // re-logging in cannot fix credentials Cartrack has already rejected.
  if (Date.now() < (_loginBlock[env] ?? 0)) return null;

  // A handshake is now unavoidable — unless one is already running, in which case wait for
  // it. Everything below this line happens ONCE no matter how many callers arrive together,
  // which is what makes the ten-way force retry from the assign loop cost one login.
  const running = _loginInFlight[env];
  if (running) return running;
  const attempt = performLogin(env, force).finally(() => { delete _loginInFlight[env]; });
  _loginInFlight[env] = attempt;
  return attempt;
}

/** The handshake itself. Only ever called through the in-flight guard above, so the shared
 *  eviction, the login and the shared write happen exactly once per burst. */
async function performLogin(env: Env, force: boolean): Promise<string | null> {
  // `force` means Cartrack just rejected the session we were holding. Evict the shared copy
  // BEFORE anything can adopt it, or every other instance inherits the dead cookie. Inside
  // the guard, so this DELETE cannot race the write at the end of a sibling's login.
  if (force) await dropSharedCookie(env);

  const suffix = env === "uat" ? "_UAT" : "";
  const auth = process.env[`CARTRACK_AUTH${suffix}`] ?? "";
  const password = process.env[`CARTRACK_WEB_PASS${suffix}`] ?? "";
  // No UAT password configured → null, NOT a prod cookie. Handing a prod session
  // to a caller that asked for UAT would run writes (reject/optimise) against live.
  if (!auth || !password) return null;

  // Decode account name from Basic auth header (ACCOUNT:apipassword)
  const decoded = atob(auth.replace(/^Basic\s+/, ""));
  const account = decoded.split(":")[0];

  try {
    const res = await fetch(JSONRPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        version: "2.0",
        method: "ct_login",
        id: 1,
        params: {
          x: "x",
          account,
          username: "",
          password,
          locale: "en-ZA",
          otp: "",
          browserName: "",
          version: "3.9.1",
          environment: env === "uat" ? "uat" : "live",
          thirdParty: false,
        },
      }),
    });
    if (!res.ok) return null;

    // A refused login still answers HTTP 200 WITH Set-Cookie headers — the verdict
    // lives in the body. Both shapes verified against prod 2026-08-10:
    //   ok:       result.status === "SUCCEEDED"
    //   refused:  result.status === "WRONG_CREDENTIALS", plus attempts_remaining
    // Without this check a wrong password caches an unauthenticated session for the
    // full 12h TTL, and every JSON-RPC call (reject, optimise, timeline) fails on it.
    // Strict where there is evidence, permissive where there isn't: an unreadable body
    // or a missing status falls through to the old behaviour, so an unexpected shape
    // can never take JSON-RPC down across the board.
    const body = (await res.json().catch(() => null)) as
      | { result?: { status?: string; attempts_remaining?: number } }
      | null;
    const loginStatus = body?.result?.status;
    if (loginStatus && loginStatus !== "SUCCEEDED") {
      const left = body?.result?.attempts_remaining;
      console.error(
        `[fleetweb] ct_login refused for ${env}: ${loginStatus}` +
          (left != null ? ` — ${left} attempts left before lockout` : "") +
          `. Check CARTRACK_WEB_PASS${suffix}.`
      );
      const until = Date.now() + LOGIN_BLOCK_MS;
      _loginBlock[env] = until;
      // Share it: the account has a finite number of attempts, and a per-process back-off
      // spends one more of them per cold instance.
      await writeSharedBlock(env, until);
      return null;
    }

    // Extract all Set-Cookie values into a single cookie string
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (!setCookies.length) return null;
    const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
    const record: CookieRecord = { cookie, expiry: Date.now() + COOKIE_TTL_MS };
    _cookieCache[env] = record;
    // Awaited, not fire-and-forget: this runs on edge routes too, where the runtime can
    // tear down as soon as the response is sent. A dropped write means the next cold
    // instance pays the handshake again, which is the entire cost this is here to avoid.
    await writeSharedCookie(env, record);
    // Logged because this line is expensive and invisible. ct_login is a TLS + auth
    // handshake: measured 2026-08-11 at ~280ms of ACTIVE CPU, against ~40-90ms for ALL the
    // parsing and index-building a steady assign cycle does. With the shared cache above
    // this should now be RARE — roughly once per 12h TTL rather than once per cold
    // instance. If these keep appearing at ~1:1 with /api/assign/cron invocations, the
    // shared cache is not working and the cron is back to spending its CPU on logging in.
    console.log(`[fleetweb] ct_login performed for ${env} — shared cache miss (cached ${COOKIE_TTL_MS / 3_600_000}h)`);
    return cookie;
  } catch {
    return null;
  }
}

export type RpcOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; error: string; status: number | null };

/** True when a response looks like "your session is gone", i.e. worth one
 *  re-login + retry. Deliberately narrow: a false positive replays the call, and
 *  some RPC methods (delivery_reject_job) mutate. HTTP 401/403 plus a small set
 *  of message shapes only. */
function isSessionExpired(status: number, errorText: string): boolean {
  if (status === 401 || status === 403) return true;
  return /\b(session|not logged in|login required|unauthenticated|unauthorized)\b/i.test(errorText);
}

function rpcErrorText(body: { error?: unknown }): string {
  const err = body.error;
  if (!err) return "";
  if (typeof err === "string") return err;
  const msg = (err as Record<string, unknown>).message;
  return typeof msg === "string" ? msg : JSON.stringify(err);
}

/**
 * Single entry point for every fleetweb JSON-RPC call: resolves the session
 * cookie for `env`, posts the request, and on a session-expiry signal forces one
 * re-login and retries once. Without the retry a session Cartrack drops early
 * leaves this process failing every RPC call until the 12h TTL rolls over.
 *
 * Returns a discriminated outcome — callers that only care about success can
 * check `.ok`; callers that surface the reason to a user (sales reject) read
 * `.error`.
 */
/** RPC methods that must never be replayed: running one twice leaves two of something.
 *  Keep this list honest — anything that creates a record belongs here. */
const NON_IDEMPOTENT_RPC = new Set(["delivery_create_job"]);

export async function jsonRpc<T = unknown>(
  method: string,
  params: unknown,
  opts: { env?: Env; id?: number } = {}
): Promise<RpcOutcome<T>> {
  const env = opts.env ?? "prod";
  const suffix = env === "uat" ? "_UAT" : "";
  const auth = process.env[`CARTRACK_AUTH${suffix}`] ?? "";
  if (!auth) return { ok: false, error: `CARTRACK_AUTH${suffix} not set`, status: null };

  const attempt = async (force: boolean): Promise<RpcOutcome<T> & { retryable?: boolean }> => {
    const cookie = await getFleetwebCookie(env, force);
    if (!cookie) return { ok: false, error: `fleetweb login failed (CARTRACK_WEB_PASS${suffix}?)`, status: null };
    try {
      const res = await fetch(JSONRPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth, Cookie: cookie },
        body: JSON.stringify({ version: "2.0", method, id: opts.id ?? 1, params }),
        cache: "no-store",
      });
      const body = await res.json().catch(() => ({}));
      const errorText = rpcErrorText(body);
      if (!res.ok || errorText) {
        const error = errorText || `HTTP ${res.status}`;
        return { ok: false, error, status: res.status, retryable: isSessionExpired(res.status, errorText) };
      }
      return { ok: true, result: body.result as T };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), status: null };
    }
  };

  const first = await attempt(false);
  if (first.ok || !first.retryable) return first;
  // Retrying is only safe for methods that can be repeated without consequence. A session
  // can expire AFTER Cartrack has acted but before we read the response, so re-running a
  // creating call makes a second job — a duplicate no dedup layer can catch, because it
  // comes from one request. Reads and idempotent updates retry as before; creates report
  // the failure and let the caller decide.
  if (NON_IDEMPOTENT_RPC.has(method)) {
    console.error(`[jsonRpc] ${method} hit a session error; NOT retrying — it may already have taken effect.`);
    return first;
  }
  return attempt(true);
}

// ---------------------------------------------------------------------------
// Job-creation fast path — fleetweb `delivery_create_job`
// ---------------------------------------------------------------------------
//
// Measured on prod 2026-07-17: REST POST /jobs ≈ 11.3s, this RPC ≈ 0.8–1.9s.
// It is the browser UI's own endpoint: camelCase fields, integer label ids,
// strict `Y-m-d\TH:i:sP` timestamps, and it rejects shapes it doesn't know.
// `restJobToRpc` therefore converts on a whitelist and anything unrecognised
// routes to plain REST unchanged. A failed RPC create leaves no job behind
// (verified), so the REST fallback after an RPC error cannot double-create.

/** fleetweb label ids for this account — the RPC only accepts integers here.
 *  Discovered by REST-creating a job with the string label and reading
 *  `labels[].labelId` back via delivery_get_job_details. A label missing from
 *  this map forces the REST path; never guess ids. */
const RPC_LABEL_IDS: Record<string, number> = {
  check_in: 728,
  check_out: 727,
  audit_weekly: 301,
  "🛵 Vận chuyển mẫu PSC": 716,
  "🛵 Vận chuyển mẫu tỉnh": 733,
  "🛵 Vận chuyển mẫu PSC (về)": 739,
  "🛵 Vận chuyển mẫu PSC (ghé)": 743,
  "📦 Booking - Vật tư": 752,
  "📅 Lịch cố định": 740,
};

/** "YYYY-MM-DD HH:mm:ss" (vnTimestamp) → the RPC's required "YYYY-MM-DDTHH:mm:ss+07:00".
 *  Null for any other shape — the caller then stays on REST. */
function toRpcTs(ts: unknown): string | null {
  if (typeof ts !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts)) return ts.replace(" ", "T") + "+07:00";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/.test(ts)) return ts;
  return null;
}

/** Convert a REST-shaped create payload to the RPC's shape, or say why not.
 *  Whitelist-only on every level: an unknown field means this payload uses
 *  something the RPC path hasn't been verified for, so it must go via REST
 *  rather than be silently dropped. */
function restJobToRpc(
  payload: Record<string, unknown>
): { data: Record<string, unknown> } | { blocked: string } {
  const bail = (msg: string): never => {
    throw new Error(msg);
  };
  const asRecord = (v: unknown, what: string): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : bail(`${what} is not an object`);
  const onlyKeys = (obj: Record<string, unknown>, allowed: Set<string>, what: string) => {
    for (const k of Object.keys(obj)) if (!allowed.has(k)) bail(`unsupported ${what} field "${k}"`);
  };

  const TODO_KEYS = new Set(["todo_type_id", "description", "is_required", "stop_type_id"]);
  const convTodos = (todos: unknown, what: string): Record<string, unknown>[] => {
    if (!Array.isArray(todos)) bail(`${what} todos is not an array`);
    return (todos as unknown[]).map((t) => {
      const todo = asRecord(t, `${what} todo`);
      onlyKeys(todo, TODO_KEYS, `${what} todo`);
      const out: Record<string, unknown> = {
        todoTypeId: todo.todo_type_id ?? bail(`${what} todo missing todo_type_id`),
        description: String(todo.description ?? ""),
        // RPC validation demands isRequired on every todo. REST stores absent
        // is_required as TRUE (verified 2026-07-17 on the PSC shape), so the
        // default must be true or drivers get optional checklists.
        isRequired: todo.is_required !== false,
      };
      if (todo.stop_type_id != null) out.stopTypeId = todo.stop_type_id;
      return out;
    });
  };

  try {
    onlyKeys(
      payload,
      new Set([
        "job_type_id", "schedule_type_id", "reference_number", "labels",
        "delivery_driver_id", "scheduled_delivery_ts", "send_to_driver_at",
        "stops", "items",
      ]),
      "job"
    );

    const STOP_KEYS = new Set(["stop_type_id", "customer_id", "duration", "note", "delivery_windows", "todos"]);
    if (!Array.isArray(payload.stops) || payload.stops.length === 0) bail("stops missing");
    const stops = (payload.stops as unknown[]).map((s) => {
      const stop = asRecord(s, "stop");
      onlyKeys(stop, STOP_KEYS, "stop");
      const out: Record<string, unknown> = {
        stopTypeId: stop.stop_type_id ?? bail("stop missing stop_type_id"),
        customerId: stop.customer_id ?? bail("stop missing customer_id"),
      };
      if (stop.duration != null) out.duration = stop.duration;
      if (stop.note) out.note = stop.note;
      if (stop.delivery_windows != null) {
        if (!Array.isArray(stop.delivery_windows)) bail("delivery_windows is not an array");
        out.deliveryWindows = (stop.delivery_windows as unknown[]).map((w) => {
          const win = asRecord(w, "delivery window");
          onlyKeys(win, new Set(["time_from", "time_to"]), "delivery window");
          const okTime = (v: unknown) => typeof v === "string" && /^\d{2}:\d{2}:\d{2}\+07:00$/.test(v);
          if (!okTime(win.time_from) || !okTime(win.time_to)) bail("delivery window time format");
          return { timeFrom: win.time_from, timeTo: win.time_to };
        });
      }
      if (stop.todos != null) out.todos = convTodos(stop.todos, "stop");
      return out;
    });

    const data: Record<string, unknown> = {
      jobTypeId: payload.job_type_id ?? bail("job_type_id missing"),
      // REST coerces schedule_type_id to 2 on every create (verified on the
      // chấm-công and PSC shapes, 2026-07-17) while the RPC stores what it's
      // told — so parity means always sending 2, whatever the caller asked for.
      // The RPC then requires scheduledDeliveryTs to be *present*; an explicit
      // null passes that check and stamps create-time, same as REST.
      scheduleTypeId: 2,
      scheduledDeliveryTs:
        payload.scheduled_delivery_ts != null
          ? toRpcTs(payload.scheduled_delivery_ts) ?? bail("scheduled_delivery_ts format")
          : null,
      referenceNumber: payload.reference_number ?? bail("reference_number missing"),
      stops,
    };
    if (payload.delivery_driver_id != null) data.deliveryDriverId = payload.delivery_driver_id;
    if (payload.labels != null) {
      if (!Array.isArray(payload.labels)) bail("labels is not an array");
      data.labels = (payload.labels as unknown[]).map((l) =>
        typeof l === "string" && RPC_LABEL_IDS[l] !== undefined ? RPC_LABEL_IDS[l] : bail(`label "${String(l)}" has no known id`)
      );
    }
    if (payload.send_to_driver_at != null) {
      data.sendToDriverAt = toRpcTs(payload.send_to_driver_at) ?? bail("send_to_driver_at format");
    }
    if (payload.items != null) {
      if (!Array.isArray(payload.items)) bail("items is not an array");
      const ITEM_KEYS = new Set(["description", "weight", "item_type_id", "quantity", "tracking_number", "todos"]);
      data.items = (payload.items as unknown[]).map((i) => {
        const item = asRecord(i, "item");
        onlyKeys(item, ITEM_KEYS, "item");
        const out: Record<string, unknown> = {
          description: String(item.description ?? ""),
          itemTypeId: item.item_type_id ?? 1,
          quantity: item.quantity ?? 1,
          weight: item.weight ?? 0,
          trackingNumber: String(item.tracking_number ?? ""),
        };
        if (item.todos != null) out.todos = convTodos(item.todos, "item");
        return out;
      });
    }
    return { data };
  } catch (e) {
    return { blocked: e instanceof Error ? e.message : String(e) };
  }
}

export type CreateJobResult = {
  ok: boolean;
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  via: "rpc" | "rest";
};

/** Driver statuses vs REST enforcement (probes 2026-07-17/18 + fleet histogram):
 *  1 = driving/mid-route (31 active drivers at midday — REST assigns them 2nd/3rd
 *  jobs all day), 2 = idle/off-duty, 3 = offline/not-yet-logged-in (44 active —
 *  REST assigns their fixed jobs pre-login every morning), 4 = available.
 *  REST refuses exactly two states: 5 "Nghỉ ngơi" on-break (422) and
 *  is_active=false / deactivated (422, different message) — note status 3 alone
 *  is NOT deactivation; the is_active flag is. Never-observed ids fall through
 *  to REST for the authoritative verdict. */
const DRIVER_STATUSES_ASSIGNABLE = new Set([1, 2, 3, 4]);
const DRIVER_STATUS_ON_BREAK = 5;

const make422 = (msg: string) => ({
  data: null,
  error: { code: 422, message: "The given data was invalid.", data: { delivery_driver_id: [msg] } },
});

/** Synthetic copies of the exact 422 bodies REST returns, so
 *  isDriverUnavailableError() and call-site error handling behave identically
 *  on the RPC path. */
const DRIVER_UNAVAILABLE_BODY = make422("Driver does not exist or the current status does not support job assignment");
const DRIVER_DEACTIVATED_BODY = make422("Driver is deactivated and cannot be assigned to a job");

/**
 * The fleetweb RPC has dispatcher-override semantics: it creates/assigns jobs
 * onto on-break AND deactivated drivers where REST refuses with a 422
 * (both verified live, 2026-07-17/18) — and the chấm-công "Nghỉ ngơi" gate
 * depends on that refusal. So assigned-at-creation payloads are gated on an
 * ALLOWLIST: only an active, status-4 driver takes the RPC path. Known-blocked
 * states get their REST-parity 422 without a create; anything else — unknown
 * status ids, driver absent from the list, list fetch failed — goes down the
 * REST path, which enforces the policy server-side.
 */
function evalDriverAssignability(d: Driver): "ok" | "on_break" | "deactivated" | "unknown" {
  if (!d.is_active) return "deactivated";
  if (d.driver_status_id === DRIVER_STATUS_ON_BREAK) return "on_break";
  return DRIVER_STATUSES_ASSIGNABLE.has(d.driver_status_id) ? "ok" : "unknown";
}

async function rpcDriverStatusGate(
  driverId: unknown,
  env: Env
): Promise<"ok" | "on_break" | "deactivated" | "unknown"> {
  if (typeof driverId !== "string" || !driverId) return "ok"; // unassigned create — nothing to gate
  try {
    const drivers = await gateDrivers(env);
    const d = drivers.find((x) => x.delivery_driver_id === driverId);
    if (!d) return "unknown";
    return evalDriverAssignability(d);
  } catch {
    return "unknown";
  }
}

/** Drivers-list micro-cache for gate lookups that arrive WITHOUT a caller-provided
 *  record (fixed-path engine assigns on smart-less cycles, Nhận Việc claims,
 *  chấm-công creates). 60s TTL turns a burst of such assigns into ONE ~1.8s list
 *  fetch instead of one per call — a 3-job fixed cycle was paying ~5.4s extra.
 *  Slightly widens the accepted staleness race (≤60s vs per-call fresh); failed
 *  or empty fetches are never cached. */
const _gateDriversCache: Partial<Record<Env, { at: number; drivers: Driver[] }>> = {};
async function gateDrivers(env: Env): Promise<Driver[]> {
  const c = _gateDriversCache[env];
  if (c && Date.now() - c.at < 60_000) return c.drivers;
  const drivers = await getDrivers(env);
  if (drivers.length) _gateDriversCache[env] = { at: Date.now(), drivers };
  return drivers;
}

/** Proxy drivers are ours (parking, duplicate-reject staging) — human driver-state
 *  rules don't apply, so the RPC assign path skips the status gate for them. */
function isProxyDriver(driverId: string): boolean {
  const rejectProxy = process.env.CARTRACK_REJECT_PROXY_DRIVER_ID ?? "";
  return driverId === PROXY_DRIVER_ID || (!!rejectProxy && driverId === rejectProxy);
}

type RpcAssignOutcome =
  | { kind: "assigned"; driverName: string | null }
  | { kind: "blocked"; body: typeof DRIVER_UNAVAILABLE_BODY }
  | { kind: "fallback" };

/**
 * RPC-first assign shared by assignJob / assignJobViaUpdate.
 * ~2.0s vs ~7.3s REST (measured 2026-07-18). Applies the same driver-state gate
 * as createJob — the fleetweb RPC would otherwise assign onto on-break and
 * deactivated drivers that REST refuses — returning the REST-identical 422
 * bodies so isDriverUnavailable()/isDriverUnavailableError() keep working.
 * `driverRec` lets the engine pass the Driver it already holds (its per-cycle
 * getDrivers list), making the gate free; without it one drivers-list fetch
 * (~1.8s) runs here. Residual race: the record can be seconds-to-minutes stale,
 * so a driver flipping to break between fetch and assign slips through — REST
 * caught that server-side; accepted as rare and driver-recoverable (reject).
 * "fallback" means: let the caller run the authoritative REST path.
 */
async function tryAssignViaRpc(
  jobId: number,
  driverId: string,
  env: Env,
  driverRec?: Driver
): Promise<RpcAssignOutcome> {
  let name: string | null = null;
  if (!isProxyDriver(driverId)) {
    let d = driverRec;
    if (!d) {
      try {
        d = (await gateDrivers(env)).find((x) => x.delivery_driver_id === driverId);
      } catch {
        /* treated as not-found below */
      }
    }
    if (!d) return { kind: "fallback" };
    const verdict = evalDriverAssignability(d);
    if (verdict === "on_break") return { kind: "blocked", body: DRIVER_UNAVAILABLE_BODY };
    if (verdict === "deactivated") return { kind: "blocked", body: DRIVER_DEACTIVATED_BODY };
    if (verdict !== "ok") return { kind: "fallback" };
    name = `${d.first_name ?? ""} ${d.last_name ?? ""}`.trim() || null;
  }
  const out = await jsonRpc<{ assignedJobIds?: number[] }>(
    "delivery_route_slice_jobs_assign",
    {
      data: {
        routeId: `driver_${driverId}`,
        jobIds: [jobId],
        updateRecurringSetup: false,
        scheduleType: "scheduled",
        filter: vnDayWindow(),
      },
    },
    { env }
  );
  if (out.ok && out.result?.assignedJobIds?.includes(jobId)) {
    return { kind: "assigned", driverName: name };
  }
  console.warn(`[assign] RPC assign failed (${out.ok ? "id not echoed" : out.error}); using REST`);
  return { kind: "fallback" };
}

/**
 * Create a job from a REST-shaped payload. Eligible payloads go through the
 * fleetweb RPC (~6x faster); ineligible payloads and any RPC failure fall back
 * to the plain REST POST, so error bodies and `isDriverUnavailableError`
 * handling behave exactly as before on that path. On success from either path
 * `body.data.job_id` / `body.data.delivery_driver_id` are present in the same
 * shape.
 */
export async function createJob(
  payload: Record<string, unknown>,
  env: Env = "prod"
): Promise<CreateJobResult> {
  const conv = restJobToRpc(payload);
  if ("blocked" in conv) {
    console.log(`[createJob] REST path: ${conv.blocked}`);
  } else {
    const gate = await rpcDriverStatusGate(payload.delivery_driver_id, env);
    if (gate === "on_break") {
      return { ok: false, status: 422, body: DRIVER_UNAVAILABLE_BODY, via: "rpc" };
    }
    if (gate === "deactivated") {
      return { ok: false, status: 422, body: DRIVER_DEACTIVATED_BODY, via: "rpc" };
    }
    if (gate === "unknown") {
      console.log("[createJob] REST path: driver status unverifiable");
    } else {
      const out = await jsonRpc<{ data?: { job_id?: number; jobId?: number } }>(
        "delivery_create_job",
        { data: conv.data },
        { env }
      );
      // Cartrack answers this RPC in camelCase (`jobId`); the REST detail endpoint uses
      // snake_case (`job_id`). A release on 2026-08-12 made that difference matter: reading
      // only `job_id` turned every successful RPC create into an apparent failure, and the
      // REST fallback below then created the SAME job a second time — ~7s apart, identical
      // reference. 16 duplicate trips in one morning before it was caught. Accept both, and
      // hand callers the snake_case shape they already read.
      if (out.ok) {
        const rpcJobId = out.result?.data?.job_id ?? out.result?.data?.jobId;
        if (rpcJobId) {
          const data = { ...(out.result?.data ?? {}), job_id: rpcJobId };
          return { ok: true, status: 200, body: { ...out.result, data }, via: "rpc" };
        }
        // THE FALLBACK IS NOT IDEMPOTENT, so it must only run when the RPC provably did
        // nothing. A transport-level failure is safe: Cartrack rejected the request and
        // created no job — verified by probe on 2026-08-12, where two rejected payloads
        // produced zero jobs. But a SUCCESSFUL call whose id we cannot read means a job
        // almost certainly exists, and posting again guarantees a twin. Fail loudly.
        console.error(
          `[createJob] RPC reported success but no job id in ${JSON.stringify(out.result).slice(0, 200)} — ` +
          `NOT falling back to REST, because the job may already exist. Check the response shape.`,
        );
        return { ok: false, status: 502, body: { error: { message: "RPC create returned an unrecognised shape" } }, via: "rpc" };
      }
      console.warn(`[createJob] RPC create failed (${out.error}); using REST`);
    }
  }
  const res = await fetch(`${BASE_URL}/jobs`, {
    method: "POST",
    headers: getHeaders(env),
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body, via: "rest" };
}

/** Adapt delivery_timeline_route_list routes → Job[] (the s4+s5 source). The
 *  timeline is per-driver, per-stop, camelCase; group stops by jobId and map to the
 *  snake_case Job shape the cycle's consumers (dedup, follow-ups, pickup-warnings)
 *  expect. The driver name comes from the route-level `driverFullname`. Only caveat:
 *  no create_ts (we substitute scheduledDeliveryTs for the return/via dedup index). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function timelineRoutesToJobs(routes: any[]): Job[] {
  // Timeline stamps full datetimes as "YYYY-MM-DD HH:MM:SS.ffffff+07"; REST omits the
  // fraction+offset on these fields and downstream code treats Cartrack times as VN-
  // local. Slice to "YYYY-MM-DD HH:MM:SS" so parsing matches the REST path exactly.
  const t19 = (s: unknown): string | null =>
    typeof s === "string" && s.length >= 19 ? s.slice(0, 19) : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byJob = new Map<number, { stops: any[]; driverName: string | null }>();
  for (const r of routes) {
    const driverName: string | null = r?.driverFullname ?? null;
    for (const s of (r?.orderedStops ?? [])) {
      if (s?.jobId == null) continue;
      const entry = byJob.get(s.jobId) ?? { stops: [], driverName };
      entry.stops.push(s);
      byJob.set(s.jobId, entry);
    }
  }
  const jobs: Job[] = [];
  for (const [jobId, { stops: raw, driverName }] of byJob) {
    const first = raw[0];
    const stops: Stop[] = raw
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((s: any): Stop => ({
        stop_id: s.stopId,
        stop_type_id: s.stopTypeId,
        stop_status_id: s.stopStatusId,
        customer_id: s.customerId,
        customer_name: s.customerName,
        name: s.customerName,
        address_line_1: s.addressLine1 ?? undefined,
        latitude: s.latitude ?? null,
        longitude: s.longitude ?? null,
        activity_started_ts: t19(s.activityStartedTs),
        activity_arrived_ts: t19(s.activityArrivedTs),
        activity_completed_ts: t19(s.activityCompletedTs),
        // window times are time-only ("HH:MM:SS+07"); buildActiveRouteMap reads HH:MM
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delivery_windows: (s.deliveryWindows ?? []).map((w: any) => ({ time_from: w?.timeFrom, time_to: w?.timeTo })),
      }))
      .sort((a: Stop, b: Stop) => (a.stop_type_id ?? 0) - (b.stop_type_id ?? 0));
    const driverId: string | null = first.deliveryDriverId ?? null;
    jobs.push({
      job_id: jobId,
      job_status_id: first.jobStatusId,
      delivery_driver_id: driverId,
      reference_number: first.referenceNumber,
      scheduled_delivery_ts: t19(first.scheduledDeliveryTs),
      create_ts: t19(first.scheduledDeliveryTs) ?? undefined, // timeline has no create_ts
      send_to_driver_at: first.sendToDriverAt ?? null,
      // Timeline returns jobLabels as objects with a .label field; REST returns strings.
      // Extract the label strings so downstream checks (labels.includes()) work.
      labels: (first.jobLabels ?? []).map((l: any) => (typeof l === 'string' ? l : l?.label)).filter(Boolean),
      last_assigned_plan_id: first.lastAssignedPlanId ?? null,
      // Batch IDs ride along on the stops (verified prod 2026-07-25) — union them so
      // the /qr list shows Mã Batch without a per-job detail fetch.
      item_tracking_numbers: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...new Set(raw.flatMap((s: any) => (s.itemTrackingNumbers ?? []) as string[])),
      ],
      // driverFullname is route-level — populate so pickup-warnings show the name.
      driver: driverId ? { delivery_driver_id: driverId, first_name: driverName ?? "", last_name: "" } : null,
      stops,
    });
  }
  return jobs;
}

/** Raw delivery_timeline_route_list fetch — returns the routes array (one ~2.3s
 *  JSON-RPC call) so a single cycle can derive BOTH the s4/s5 jobs
 *  (timelineRoutesToJobs) and the per-driver smart-rank info from the SAME payload,
 *  instead of calling this method twice. null on any failure (prod-only cookie,
 *  non-2xx, bad shape) so callers can fall back to REST.
 *
 *  THE single entry point for delivery_timeline_route_list — the assign cycle, the
 *  smart-assign preview, the Nhận Việc claim list and the branch/driver feeds all
 *  come through here. Anyone tempted to hand-roll the JSON-RPC envelope again: don't.
 *  Four copies of it drifted apart once already, and the request shape (scheduleType,
 *  the VN day window) has to stay identical or the callers disagree about what a
 *  "day" is. */
export async function getTimelineRoutes(dateVn: string, env: Env = "prod"): Promise<TimelineRoute[] | null> {
  if (env !== "prod") return null; // fleetweb login is prod-only in practice; UAT falls back to REST
  const out = await jsonRpc<{ routes?: unknown }>(
    "delivery_timeline_route_list",
    { data: { scheduleType: "scheduled", filter: vnDayWindow(dateVn) } },
    { env }
  );
  if (!out.ok) return null;
  const routes = out.result?.routes;
  return Array.isArray(routes) ? (routes as TimelineRoute[]) : null;
}

/** Today's assigned+completed jobs via the route-timeline (JSON-RPC) instead of the
 *  heavy/variable getJobsByDate. Returns Job[] on success, or null on any failure
 *  (prod-only cookie, non-2xx, bad shape) so the caller can fall back to REST. */
export async function getTimelineJobs(dateVn: string, env: Env = "prod"): Promise<Job[] | null> {
  const routes = await getTimelineRoutes(dateVn, env);
  return routes ? timelineRoutesToJobs(routes) : null;
}

/** Jobs that sit on no driver's route — Cartrack's "new jobs" pool (delivery_jobs_list_new,
 *  the same call its map view uses). Returns BOTH unassigned (status 2) and rejected
 *  (status 3) jobs, which is the whole point: getTimelineRoutes only ever contains
 *  statuses 4 and 5, so neither state is reachable from it.
 *
 *  Note a sampling trap when verifying this: on a finished day everything unassigned has
 *  since been assigned, so the response looks like it is rejected-only. Check a day that
 *  is still running to see both.
 *
 *  Rejected jobs carry rejectedTs / rejectedReason / rejectedByName; unassigned ones have
 *  those null. prod-only (fleetweb cookie); null on any failure so callers can degrade. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getUnroutedJobs(dateVn: string, env: Env = "prod"): Promise<any[] | null> {
  if (env !== "prod") return null;
  const out = await jsonRpc<{ jobs?: unknown }>(
    "delivery_jobs_list_new",
    { data: { scheduleType: "scheduled", filter: vnDayWindow(dateVn) } },
    { env }
  );
  if (!out.ok) return null;
  const jobs = out.result?.jobs;
  return Array.isArray(jobs) ? jobs : null;
}

/** Label-filtered stops for a day via delivery_get_stops_list (JSON-RPC). The label
 *  filter runs server-side, so this returns only matching stops — far lighter than
 *  getJobsByDate, which pulls every job for the day and is then filtered client-side.
 *
 *  Stops come back flat (one entry per stop), each carrying job_id, reference_number,
 *  job_status_id, stop_type_id/status, customer_name, driver_name, address_line_1,
 *  activity timestamps and delivery_windows — so the caller groups by job_id and has
 *  every field the PSC-tỉnh orders view needs in a single call. assignment:"all"
 *  includes unassigned (status 2) jobs, so freshly-created requests still surface.
 *
 *  prod-only (fleetweb cookie); returns null on any failure so callers can fall back to
 *  REST. perPage 200 comfortably holds a day of PSC-tỉnh stops (≈24) — a label-filtered
 *  day has never approached one page, so pagination is intentionally not followed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getStopsByLabels(dateVn: string, labels: string[], env: Env = "prod"): Promise<any[] | null> {
  if (env !== "prod") return null; // fleetweb login is prod-only in practice; UAT falls back to REST
  const out = await jsonRpc<{ stops?: unknown }>(
    "delivery_get_stops_list",
    {
      data: {
        filters: { scheduledDeliveryTs: vnDayWindow(dateVn), groupStops: true, assignment: "all", jobLabel: labels },
        sort: {},
        pagination: { page: 1, perPage: 200 },
      },
    },
    { env }
  );
  if (!out.ok) return null;
  const stops = out.result?.stops;
  return Array.isArray(stops) ? stops : null;
}

/** Login then trigger route optimisation for a single driver (JSON-RPC).
 *  Requires CARTRACK_AUTH + CARTRACK_WEB_PASS env vars.
 *  Returns true if the API accepted the request. */
export async function optimizeDriverRoute(
  driverId: string,
  dateVn: string, // YYYY-MM-DD in Vietnam time
  env: Env = "prod"
): Promise<boolean> {
  const out = await jsonRpc(
    "delivery_route_stops_optimize",
    { data: { routeId: `driver_${driverId}`, scheduleType: "scheduled", filter: vnDayWindow(dateVn) } },
    { env }
  );
  return out.ok;
}

export async function getJobDetails(
  jobId: number,
  env: Env = "prod"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ data: any }> {
  const res = await fetch(`${BASE_URL}/jobs/${jobId}`, {
    headers: getHeaders(env),
    cache: "no-store",
  });

  if (!res.ok) return { data: {} };
  return res.json();
}

/** "2026-07-18 18:18:19+07" / "…18:14:15.698021+07" → "2026-07-18 18:18:19" —
 *  fleetweb reads suffix timestamps that REST never does; parseVnTimestamp would
 *  mangle the suffix, so strip it to the REST shape. */
function stripTzSuffix<T>(ts: T): T {
  return (typeof ts === "string" ? ts.replace(/(\.\d+)?\+07(:00)?$/, "") : ts) as T;
}

/**
 * Fast source for today's UNASSIGNED (status 2) jobs — the one list the route
 * timeline can't provide (a driverless job is on nobody's route). Two RPCs:
 * delivery_jobs_list_new for ids (~0.3s; only returns status 2/3, and its
 * filter window keys on scheduled_delivery_ts — both verified 2026-07-18), then
 * delivery_get_job_details for full records (~0.1s) — notes (✅ gate), delivery
 * windows (hold gate), labels (dup exemption) and delivery_driver_id all read
 * back byte-equal to REST apart from a "+07" timestamp suffix, normalised here.
 * Replaces the ~5–10s REST status-2 list on every cycle.
 *
 * Returns null on ANY doubt — RPC error, unexpected shape — so the caller runs
 * the authoritative REST list instead. A well-formed empty result is trusted as
 * genuinely empty (it is a live response, not a cache).
 *
 * `pool` hands back the raw delivery_jobs_list_new rows this call already paid for —
 * the same payload getUnroutedJobs fetches, statuses 2 AND 3. `jobs` narrows to status 2
 * because that is all the assign cycle acts on; the day snapshot needs the rejected ones
 * too, and would otherwise repeat this identical RPC seconds later to get them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getUnassignedJobsFast(dateVn: string, env: Env = "prod"): Promise<{ jobs: Job[]; pool: any[] } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ln = await jsonRpc<{ jobs?: any[] }>(
    "delivery_jobs_list_new",
    { data: { scheduleType: "scheduled", filter: vnDayWindow(dateVn) } },
    { env }
  );
  if (!ln.ok || !Array.isArray(ln.result?.jobs)) return null;
  const pool = ln.result.jobs;
  const ids = pool.filter((j) => j.jobStatusId === 2 && j.jobId).map((j) => j.jobId as number);
  if (ids.length === 0) return { jobs: [], pool };

  const det = await jsonRpc<{ jobs?: Record<string, unknown>[] }>(
    "delivery_get_job_details",
    { data: { jobIds: ids } },
    { env }
  );
  if (!det.ok || !Array.isArray(det.result?.jobs)) return null;

  const out: Job[] = [];
  for (const dj of det.result.jobs) {
    const stops = dj.stop ?? dj.stops;
    if (!dj.job_id || !Array.isArray(stops)) return null; // shape surprise → REST
    out.push({
      ...dj,
      scheduled_delivery_ts: stripTzSuffix(dj.scheduled_delivery_ts),
      send_to_driver_at: stripTzSuffix(dj.send_to_driver_at ?? dj.sendToDriverAt ?? null),
      create_ts: stripTzSuffix(dj.create_ts),
      labels: (Array.isArray(dj.labels) ? dj.labels : [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((l: any) => (typeof l === "string" ? l : l?.label))
        .filter(Boolean),
      stops,
    } as unknown as Job);
  }
  return { jobs: out, pool };
}

export async function getJobsByStatusAndDate(
  statusId: number,
  dateVn: string, // "YYYY-MM-DD"
  env: Env = "prod"
): Promise<Job[]> {
  // Paginate to exhaustion: a single page caps at 1000 rows and busy days now
  // approach that (825 assigned jobs on 2026-06-12). Silent truncation would
  // drop jobs from duplicate detection, via-legs and return-trip dedup.
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 5;
  const all: Job[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      "filter[job_status_id]": String(statusId),
      "filter[scheduled_delivery_ts_from]": `${dateVn} 00:00:00`,
      "filter[scheduled_delivery_ts_to]": `${dateVn} 23:59:59`,
      page: String(page),
      limit: String(PAGE_SIZE),
      per_page: String(PAGE_SIZE),
    });
    const r = await fetch(`${BASE_URL}/jobs?${params}`, {
      headers: getHeaders(env),
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`getJobsByStatusAndDate ${statusId} failed: ${r.status}`);
    const json = await r.json();
    const batch: Job[] = json.data ?? [];
    let added = 0;
    for (const j of batch) {
      if (seen.has(j.job_id)) continue;
      seen.add(j.job_id);
      all.push(j);
      added++;
    }
    // A short page is the last page. `added === 0` guards against an API that
    // ignores `page` and replays the same rows forever.
    if (batch.length < PAGE_SIZE || added === 0) break;
    if (page === MAX_PAGES) {
      console.warn(`[cartrack] getJobsByStatusAndDate(${statusId}, ${dateVn}) hit the ${MAX_PAGES}-page cap — list may be truncated`);
    }
  }
  return all;
}

/**
 * ALL jobs scheduled for `dateVn`, every status, paginated to exhaustion — one
 * Cartrack call the cycle partitions into status 2/4/5 locally, instead of three
 * separate status-filtered fetches. Returns more rows than the sum of 2+4+5
 * (it also carries cancelled/rejected jobs, which the caller skips), so the
 * page cap is higher.
 */
export async function getJobsByDate(dateVn: string, env: Env = "prod"): Promise<Job[]> {
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 10;
  const all: Job[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      "filter[scheduled_delivery_ts_from]": `${dateVn} 00:00:00`,
      "filter[scheduled_delivery_ts_to]": `${dateVn} 23:59:59`,
      page: String(page),
      limit: String(PAGE_SIZE),
      per_page: String(PAGE_SIZE),
    });
    const r = await fetch(`${BASE_URL}/jobs?${params}`, {
      headers: getHeaders(env),
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`getJobsByDate ${dateVn} failed: ${r.status}`);
    const json = await r.json();
    const batch: Job[] = json.data ?? [];
    let added = 0;
    for (const j of batch) {
      if (seen.has(j.job_id)) continue;
      seen.add(j.job_id);
      all.push(j);
      added++;
    }
    if (batch.length < PAGE_SIZE || added === 0) break;
    if (page === MAX_PAGES) {
      console.warn(`[cartrack] getJobsByDate(${dateVn}) hit the ${MAX_PAGES}-page cap — list may be truncated`);
    }
  }
  return all;
}
