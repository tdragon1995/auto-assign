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

const JSONRPC_URL = "https://fleetweb-vn.cartrack.com/jsonrpc/index.php";
const COOKIE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

let _cachedCookie: string | null = null;
let _cookieExpiry = 0;

/** Login to fleetweb and return a session cookie string, or null on failure. */
async function getFleetwebCookie(): Promise<string | null> {
  if (_cachedCookie && Date.now() < _cookieExpiry) {
    console.log("[optimize] Using cached fleetweb cookie (expires in", Math.round((_cookieExpiry - Date.now()) / 60000), "min)");
    return _cachedCookie;
  }

  const auth = process.env.CARTRACK_AUTH ?? "";
  const password = process.env.CARTRACK_WEB_PASS ?? "";
  console.log("[optimize] CARTRACK_AUTH set:", !!auth, "| CARTRACK_WEB_PASS set:", !!password);
  if (!auth || !password) return null;

  // Decode account name from Basic auth header (ACCOUNT:apipassword)
  const decoded = atob(auth.replace(/^Basic\s+/, ""));
  const account = decoded.split(":")[0];
  console.log("[optimize] Logging in as account:", account);

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
    console.log("[optimize] ct_login response status:", res.status);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.log("[optimize] ct_login failed body:", body);
      return null;
    }

    const setCookies = res.headers.getSetCookie?.() ?? [];
    console.log("[optimize] Set-Cookie headers received:", setCookies.length);
    if (!setCookies.length) return null;
    _cachedCookie = setCookies.map((c) => c.split(";")[0]).join("; ");
    _cookieExpiry = Date.now() + COOKIE_TTL_MS;
    console.log("[optimize] Login successful, cookie cached");
    return _cachedCookie;
  } catch (e) {
    console.log("[optimize] ct_login exception:", e);
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
  console.log("[optimize] optimizeDriverRoute called | driver:", driverId, "| date:", dateVn);
  if (!auth) {
    console.log("[optimize] CARTRACK_AUTH not set, aborting");
    return false;
  }

  const cookie = await getFleetwebCookie();
  if (!cookie) {
    console.log("[optimize] Could not get fleetweb cookie, aborting");
    return false;
  }

  try {
    const payload = {
      version: "2.0",
      method: "delivery_route_stops_optimize",
      id: 1,
      params: {
        data: {
          routeId: `driver_${driverId}`,
          scheduleType: "scheduled",
          filter: {
            from: `${dateVn}T00:00:00+07:00`,
            to: `${dateVn}T23:59:59+07:00`,
          },
        },
      },
    };
    console.log("[optimize] Sending optimize payload:", JSON.stringify(payload.params.data));
    const res = await fetch(JSONRPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth, Cookie: cookie },
      body: JSON.stringify(payload),
    });
    const body = await res.text().catch(() => "");
    console.log("[optimize] optimize response status:", res.status, "| body:", body.slice(0, 300));
    return res.ok;
  } catch (e) {
    console.log("[optimize] optimize exception:", e);
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
