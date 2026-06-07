import type { Driver, Job } from "./types";
import { vnDate, vnDayWindow } from "./time";

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

export async function getDriverJobs(
  driverId: string,
  dateVn: string,
  env: Env = "prod"
): Promise<Job[]> {
  const params = new URLSearchParams({
    "filter[job_status_id]": "4",
    "filter[create_ts_from]": `${dateVn} 00:00:00`,
    "filter[create_ts_to]": `${dateVn} 23:59:59`,
    per_page: "200",
  });

  const res = await fetch(`${BASE_URL}/drivers/${driverId}/jobs?${params}`, {
    headers: getHeaders(env),
    cache: "no-store",
  });

  if (!res.ok) return [];
  const data = await res.json();
  return data.data ?? [];
}

/** Fetch all assigned jobs for a driver with no date filter.
 *  Used by releaseDueProxyJobs so multi-day parked jobs (created on a previous
 *  day) are still found and released when their send_to_driver_at arrives. */
export async function getAllAssignedDriverJobs(
  driverId: string,
  env: Env = "prod"
): Promise<Job[]> {
  const params = new URLSearchParams({
    "filter[job_status_id]": "4",
    per_page: "200",
  });

  const res = await fetch(`${BASE_URL}/drivers/${driverId}/jobs?${params}`, {
    headers: getHeaders(env),
    cache: "no-store",
  });

  if (!res.ok) return [];
  const data = await res.json();
  return data.data ?? [];
}

export async function getUnassignedJobs(
  page = 1,
  perPage = 50,
  env: Env = "prod",
  dateVn?: string,
): Promise<{ data: Job[] }> {
  const today = dateVn ?? vnDate();
  const params = new URLSearchParams({
    "filter[job_status_id]": "2",
    "filter[create_ts_from]": `${today} 00:00:00`,
    "filter[create_ts_to]": `${today} 23:59:59`,
    page: String(page),
    per_page: String(perPage),
  });

  const res = await fetch(`${BASE_URL}/jobs?${params}`, {
    headers: getHeaders(env),
    cache: "no-store",
  });

  if (!res.ok) return { data: [] };
  return res.json();
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
  const res = await fetch(`${BASE_URL}/jobs/${jobId}?force=true`, {
    method: "DELETE",
    headers: getHeaders(env),
  });
  return res.ok;
}

export async function assignJob(
  driverId: string,
  jobId: number,
  env: Env = "prod"
): Promise<{
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}> {
  const res = await fetch(`${BASE_URL}/jobs/assign/${driverId}`, {
    method: "PUT",
    headers: getHeaders(env),
    body: JSON.stringify({ job_ids: [jobId] }),
  });
  return { status: res.status, body: await res.json() };
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

export async function updateJobStops(
  jobId: number,
  stops: { stop_id: number; stop_type_id: number; customer_id: string; customer_name?: string; note?: string; country_id?: number; delivery_windows?: { time_from: string; time_to: string }[] }[],
  env: Env = "prod"
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}/jobs/${jobId}`, {
    method: "PUT",
    headers: getHeaders(env),
    body: JSON.stringify({ stops }),
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
  // Cartrack requires allowed_to_start_at to be AFTER now. Midnight of the scheduled
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
      scheduled_delivery_ts: scheduledDeliveryTs,
      allowed_to_start_at: allowedToStartAt,
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

export async function unassignJob(
  jobId: number,
  env: Env = "prod"
): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`${BASE_URL}/jobs/${jobId}`, {
    method: "PUT",
    headers: getHeaders(env),
    body: JSON.stringify({ delivery_driver_id: null }),
  });
  return { ok: res.ok, status: res.status };
}

export const JSONRPC_URL = "https://fleetweb-vn.cartrack.com/jsonrpc/index.php";
const COOKIE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

let _cachedCookie: string | null = null;
let _cookieExpiry = 0;

/** Login to fleetweb and return a session cookie string, or null on failure. */
export async function getFleetwebCookie(): Promise<string | null> {
  if (_cachedCookie && Date.now() < _cookieExpiry) return _cachedCookie;
  const auth = process.env.CARTRACK_AUTH ?? "";
  const password = process.env.CARTRACK_WEB_PASS ?? "";
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
          environment: "live",
          thirdParty: false,
        },
      }),
    });
    if (!res.ok) return null;

    // Extract all Set-Cookie values into a single cookie string
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (!setCookies.length) return null;
    _cachedCookie = setCookies.map((c) => c.split(";")[0]).join("; ");
    _cookieExpiry = Date.now() + COOKIE_TTL_MS;
    return _cachedCookie;
  } catch {
    return null;
  }
}

/** Login then trigger route optimisation for a single driver (JSON-RPC).
 *  Requires CARTRACK_AUTH + CARTRACK_WEB_PASS env vars.
 *  Returns true if the API accepted the request. */
export async function optimizeDriverRoute(
  driverId: string,
  dateVn: string // YYYY-MM-DD in Vietnam time
): Promise<boolean> {
  const auth = process.env.CARTRACK_AUTH ?? "";
  if (!auth) return false;

  const cookie = await getFleetwebCookie();
  if (!cookie) return false;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: auth,
    Cookie: cookie,
  };

  try {
    const res = await fetch(JSONRPC_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: "2.0",
        method: "delivery_route_stops_optimize",
        id: 1,
        params: {
          data: {
            routeId: `driver_${driverId}`,
            scheduleType: "scheduled",
            filter: vnDayWindow(dateVn),
          },
        },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
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
  const params = new URLSearchParams({
    "filter[job_status_id]": String(statusId),
    "filter[scheduled_delivery_ts_from]": `${dateVn} 00:00:00`,
    "filter[scheduled_delivery_ts_to]": `${dateVn} 23:59:59`,
    page: "1",
    per_page: "1000",
  });
  const r = await fetch(`${BASE_URL}/jobs?${params}`, {
    headers: getHeaders(env),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`getJobsByStatusAndDate ${statusId} failed: ${r.status}`);
  const json = await r.json();
  return json.data ?? [];
}
