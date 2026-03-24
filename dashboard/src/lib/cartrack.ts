import type { Driver, Job } from "./types";

export type Env = "prod" | "uat";

const BASE_URL = "https://fleetapi-vn.cartrack.com/rest/delivery";

function getHeaders(env: Env = "prod"): Record<string, string> {
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

export async function getTodayJobs(env: Env = "prod"): Promise<{ data: Job[] }> {
  // Vietnam is UTC+7
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  const nowVn = new Date(Date.now() + VN_OFFSET_MS);
  const startOfDayUtc = new Date(
    Date.UTC(nowVn.getUTCFullYear(), nowVn.getUTCMonth(), nowVn.getUTCDate()) - VN_OFFSET_MS
  );
  const endOfDayUtc = new Date(startOfDayUtc.getTime() + 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    "filter[scheduled_delivery_ts_from]": String(Math.floor(startOfDayUtc.getTime() / 1000)),
    "filter[scheduled_delivery_ts_to]": String(Math.floor(endOfDayUtc.getTime() / 1000)),
    page: "1",
    per_page: "100",
  });

  const res = await fetch(`${BASE_URL}/jobs?${params}`, {
    headers: getHeaders(env),
    cache: "no-store",
  });

  if (!res.ok) return { data: [] };
  return res.json();
}

export async function getUnassignedJobs(
  page = 1,
  perPage = 50,
  env: Env = "prod"
): Promise<{ data: Job[] }> {
  const params = new URLSearchParams({
    "filter[job_status_id]": "2",
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
    })
  );
}

export async function assignJob(
  driverId: string,
  jobId: number,
  firstName_lastName?: string,
  env: Env = "prod"
): Promise<{
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  identifierUsed: string;
}> {
  const payload = { job_ids: [jobId] };
  const headers = getHeaders(env);

  // Try name-first if provided
  if (firstName_lastName) {
    const encoded = encodeURIComponent(firstName_lastName);
    const res = await fetch(`${BASE_URL}/jobs/assign/${encoded}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    });
    if (res.status === 200) {
      return {
        status: 200,
        body: await res.json(),
        identifierUsed: firstName_lastName,
      };
    }
  }

  // Fallback to driver UUID
  const res = await fetch(`${BASE_URL}/jobs/assign/${driverId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(payload),
  });

  return {
    status: res.status,
    body: await res.json(),
    identifierUsed: driverId,
  };
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
  stops: { stop_id: number; stop_type_id: number; customer_id: string; customer_name?: string }[],
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
