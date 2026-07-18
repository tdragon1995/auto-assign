import type { Driver, Job, Stop } from "./types";
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
  // With CREATE_JOB_RPC=1, try the fleetweb RPC first — measured ~2s vs ~4.7s
  // REST (2026-07-17), and it deletes jobs created by either path. deletedJobIds
  // echoes the ids actually removed; anything else (error, id absent) falls
  // through to REST for the authoritative answer.
  if (process.env.CREATE_JOB_RPC === "1") {
    const out = await jsonRpc<{ deletedJobIds?: Record<string, number> }>(
      "delivery_delete_job",
      { data: { jobIds: [jobId] } },
      { env }
    );
    if (out.ok && out.result?.deletedJobIds?.[jobId] !== undefined) return true;
  }
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
  // With CREATE_JOB_RPC=1, prefer the fleetweb RPC (measured ~2.2s vs ~5.5s REST,
  // 2026-07-18). Verified: the `filter` window is NOT sensitive (a job scheduled
  // another day still unassigns) and the routeId is NOT validated against the
  // job's current driver — the jobIds drive the operation — so a missing/imperfect
  // driver hint can't unassign the wrong job. Confirm the id echoes back in
  // unassignedJobs; anything else falls through to the authoritative REST PUT.
  // Unlike delete, unassign has no driver-state concern (it removes, not adds).
  if (process.env.CREATE_JOB_RPC === "1") {
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

/** Login to fleetweb and return a session cookie string, or null on failure.
 *  `force` skips the cache — used by jsonRpc() to re-login when Cartrack rejects
 *  a session before our TTL expects it to. */
export async function getFleetwebCookie(env: Env = "prod", force = false): Promise<string | null> {
  const cached = _cookieCache[env];
  if (!force && cached && Date.now() < cached.expiry) return cached.cookie;

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

    // Extract all Set-Cookie values into a single cookie string
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (!setCookies.length) return null;
    const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
    _cookieCache[env] = { cookie, expiry: Date.now() + COOKIE_TTL_MS };
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
  return attempt(true);
}

// ---------------------------------------------------------------------------
// Job-creation fast path — fleetweb `delivery_create_job` (CREATE_JOB_RPC=1)
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

/** Driver statuses observed against REST enforcement (2026-07-17/18 probes):
 *  2 (off-duty/idle) and 4 (available) — REST assigns to both;
 *  5 = "Nghỉ ngơi" on-break — REST 422s;
 *  is_active=false (deactivated; seen with status 3) — REST 422s, different message. */
const DRIVER_STATUSES_ASSIGNABLE = new Set([2, 4]);
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
    const drivers = await getDrivers(env);
    const d = drivers.find((x) => x.delivery_driver_id === driverId);
    if (!d) return "unknown";
    return evalDriverAssignability(d);
  } catch {
    return "unknown";
  }
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
 * RPC-first assign shared by assignJob / assignJobViaUpdate (CREATE_JOB_RPC=1).
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
  if (process.env.CREATE_JOB_RPC !== "1") return { kind: "fallback" };
  let name: string | null = null;
  if (!isProxyDriver(driverId)) {
    let d = driverRec;
    if (!d) {
      try {
        d = (await getDrivers(env)).find((x) => x.delivery_driver_id === driverId);
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
 * Create a job from a REST-shaped payload. With CREATE_JOB_RPC=1 eligible
 * payloads go through the fleetweb RPC (~6x faster); ineligible payloads and
 * any RPC failure fall back to the plain REST POST, so error bodies and
 * `isDriverUnavailableError` handling behave exactly as before on that path.
 * On success from either path `body.data.job_id` / `body.data.delivery_driver_id`
 * are present in the same shape.
 */
export async function createJob(
  payload: Record<string, unknown>,
  env: Env = "prod"
): Promise<CreateJobResult> {
  if (process.env.CREATE_JOB_RPC === "1") {
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
        const out = await jsonRpc<{ data?: { job_id?: number } }>(
          "delivery_create_job",
          { data: conv.data },
          { env }
        );
        if (out.ok && out.result?.data?.job_id) {
          return { ok: true, status: 200, body: out.result, via: "rpc" };
        }
        console.warn(`[createJob] RPC create failed (${out.ok ? "no job_id in result" : out.error}); using REST`);
      }
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
 *  non-2xx, bad shape) so callers can fall back to REST. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getTimelineRoutes(dateVn: string, env: Env = "prod"): Promise<any[] | null> {
  if (env !== "prod") return null; // fleetweb login is prod-only in practice; UAT falls back to REST
  const out = await jsonRpc<{ routes?: unknown }>(
    "delivery_timeline_route_list",
    { data: { scheduleType: "scheduled", filter: vnDayWindow(dateVn) } },
    { env }
  );
  if (!out.ok) return null;
  const routes = out.result?.routes;
  return Array.isArray(routes) ? routes : null;
}

/** Today's assigned+completed jobs via the route-timeline (JSON-RPC) instead of the
 *  heavy/variable getJobsByDate. Returns Job[] on success, or null on any failure
 *  (prod-only cookie, non-2xx, bad shape) so the caller can fall back to REST. */
export async function getTimelineJobs(dateVn: string, env: Env = "prod"): Promise<Job[] | null> {
  const routes = await getTimelineRoutes(dateVn, env);
  return routes ? timelineRoutesToJobs(routes) : null;
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
