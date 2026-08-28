import { Redis } from "@upstash/redis";
import { vnDate, addDays } from "./time";

// ── KiotViet sales stats (revenue + order count) ─────────────────────────────
// Auth is the internal web session, obtained one of two ways:
//
//   1. auto-login — KIOTVIET_USERNAME/PASSWORD against api/account/login. Mints a
//                   token, caches it in Redis, renews before expiry. No upkeep.
//   2. pasted     — KIOTVIET_SESSION_TOKEN copied from a browser. Fallback for when
//                   credentials aren't configured; dies after ~28 days.
//
// The official Public API was tried and REMOVED. Its client_credentials login worked,
// but every invoice query came back 403 "Invalid Role" — a permission grant that has
// to be made inside KiotViet admin and never took effect. It also can't be reached by
// the SSO password grant (`grant_types_supported` omits `password`), so there was no
// way to drive it from credentials alone. Don't reintroduce it without first
// confirming a plain /invoices call returns 200.

const INTERNAL_API_URL = "https://api-man1.kiotviet.vn";

const RETAILER = process.env.KIOTVIET_RETAILER ?? "nhathuocdiag";
const BRANCH_ID = Number(process.env.KIOTVIET_BRANCH_ID ?? 95562);
const GROUP_ID = process.env.KIOTVIET_GROUP_ID ?? "45";

function getRedis() {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export type AuthMode = "session";

export interface SalesStats {
  date: string;        // YYYY-MM-DD (VN date)
  revenue: number;     // đồng
  orders: number;      // invoice count
  source: AuthMode;
}

/** A half-open [from, to) window plus the label the resulting stats carry. */
interface Range {
  from: string;  // "YYYY-MM-DDTHH:MM:SS"
  to: string;
  label: string; // the date (or month) the caller asked about
}

/** One VN day. `untilClock` ("HH:MM") caps it, so today-so-far can be compared
 *  against an earlier day cut at the same minute rather than its finished total. */
function dayRange(date: string, untilClock?: string): Range {
  return {
    from: `${date}T00:00:00`,
    to: untilClock ? `${date}T${untilClock}:59` : `${addDays(date, 1)}T00:00:00`,
    label: date,
  };
}

/** Month-to-date: the 1st through the same cut-off `dayRange` would use, so the
 *  running total includes today's trading rather than stopping at midnight. */
function monthToDateRange(date: string, untilClock?: string): Range {
  return {
    from: `${date.slice(0, 7)}-01T00:00:00`,
    to: dayRange(date, untilClock).to,
    label: date.slice(0, 7),
  };
}

/** Sales stats via the internal dashboard endpoint the KiotViet web UI itself calls.
 *  One request, server-side aggregates already computed. Requires a session JWT. */
async function statsFromSession(token: string, range: Range): Promise<SalesStats> {
  const filter =
    `(BranchId eq ${BRANCH_ID} and (Status eq 1 or Status eq 3) and ` +
    `(PurchaseDate ge datetime'${range.from}' and PurchaseDate lt datetime'${range.to}'))`;

  const res = await fetch(
    `${INTERNAL_API_URL}/api/invoices/dashboard?${new URLSearchParams({ $filter: filter })}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Retailer: RETAILER,
        "X-RETAILER-CODE": RETAILER,
        "X-GROUP-ID": GROUP_ID,
        BranchId: String(BRANCH_ID),
        "X-Language": "vi-VN",
        IsUseKvClient: "1",
        Referer: `https://${RETAILER}.kiotviet.vn/`,
        Accept: "application/json, text/plain, */*",
      },
    }
  );

  if (res.status === 401 || res.status === 403) {
    throw new KiotAuthError("Session token hết hạn hoặc không hợp lệ.");
  }
  if (!res.ok) {
    throw new Error(`KiotViet ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const json = (await res.json()) as { Total1Value?: number; Total?: number };
  return {
    date: range.label,
    revenue: json.Total1Value ?? 0,
    orders: json.Total ?? 0,
    source: "session",
  };
}

/** Raised when KiotViet credentials are missing or stale — the bot surfaces this
 *  verbatim so a dead token is visible in chat rather than silently returning 0đ. */
export class KiotAuthError extends Error {}

// Cached auto-login session token, so one login serves every request until it expires.
const SESSION_KEY = "kiot:session_token";

/** Seconds until a JWT's `exp`, or null if it can't be read. */
function secondsUntilExpiry(jwt: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
    if (typeof payload.exp !== "number") return null;
    return payload.exp - Math.floor(Date.now() / 1000);
  } catch {
    return null;
  }
}

/** Dig a JWT out of a login response whose exact shape isn't documented. Checks the
 *  plausible field names, then falls back to finding any JWT-shaped string anywhere
 *  in the body — cheaper than guessing wrong and shipping a broken login. */
function extractJwt(body: unknown): string | null {
  const direct = body as Record<string, unknown> | null;
  for (const key of ["Token", "token", "AccessToken", "access_token", "Jwt", "jwt"]) {
    const v = direct?.[key];
    if (typeof v === "string" && v.startsWith("ey")) return v;
  }
  const nested = (direct?.Data ?? direct?.data) as Record<string, unknown> | undefined;
  for (const key of ["Token", "token", "AccessToken", "access_token"]) {
    const v = nested?.[key];
    if (typeof v === "string" && v.startsWith("ey")) return v;
  }
  const m = JSON.stringify(body ?? "").match(/ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

/** Log in with KIOTVIET_USERNAME/PASSWORD to mint a fresh session token.
 *
 *  This is the *internal web* login (api/account/login), NOT the SSO — the SSO has no
 *  password grant, which is why the session token was manual for so long. The payload
 *  is nested under `model`; a flat body is rejected with "nhập đầy đủ thông tin".
 *
 *  The password is read from the environment only. It is never logged, never returned,
 *  and only leaves the server in this one request to KiotViet itself. */
async function loginForSessionToken(): Promise<string | null> {
  const username = process.env.KIOTVIET_USERNAME?.trim();
  const password = process.env.KIOTVIET_PASSWORD;
  if (!username || !password) return null;

  const res = await fetch(`${INTERNAL_API_URL}/api/account/login?quan-ly=true`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      Accept: "application/json, text/plain, */*",
      Retailer: RETAILER,
      "X-Language": "vi-VN",
      IsUseKvClient: "1",
      LatestBranchId: String(BRANCH_ID),
      Origin: `https://${RETAILER}.kiotviet.vn`,
      Referer: `https://${RETAILER}.kiotviet.vn/`,
    },
    body: JSON.stringify({
      model: {
        RememberMe: true,
        ShowCaptcha: false,
        UserName: username,
        Password: password,
        Language: "vi-VN",
        LatestBranchId: BRANCH_ID,
      },
      IsManageSide: true,
      FingerPrintKey: process.env.KIOTVIET_FINGERPRINT ?? "",
    }),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    console.error("[kiotviet] login failed", res.status, text.slice(0, 200));
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error("[kiotviet] login returned non-JSON");
    return null;
  }

  const jwt = extractJwt(parsed);
  if (!jwt) {
    // Field names only — never the values, which include the token itself.
    console.error(
      "[kiotviet] login ok but no JWT found; response keys:",
      Object.keys((parsed as Record<string, unknown>) ?? {}).join(",")
    );
    return null;
  }
  return jwt;
}

/** A usable session token: the cached auto-login one, a fresh login, or the manually
 *  pasted fallback. Auto-login means the 28-day expiry stops being a manual chore. */
async function getSessionToken(): Promise<string | null> {
  const redis = getRedis();
  if (redis) {
    const cached = await redis.get<string>(SESSION_KEY);
    // Re-login early rather than racing the expiry mid-request.
    if (cached && (secondsUntilExpiry(cached) ?? 0) > 300) return cached;
  }

  const fresh = await loginForSessionToken();
  if (fresh) {
    const ttl = secondsUntilExpiry(fresh);
    if (redis && ttl && ttl > 600) {
      await redis.set(SESSION_KEY, fresh, { ex: ttl - 300 });
    }
    return fresh;
  }

  return process.env.KIOTVIET_SESSION_TOKEN?.trim() || null;
}

/** Revenue + order count for a VN date (defaults to today).
 *  `untilClock` ("HH:MM") caps the window, so today-so-far can be compared against
 *  yesterday-to-the-same-minute rather than against yesterday's finished total. */
export async function getSalesStats(
  date: string = vnDate(),
  untilClock?: string
): Promise<SalesStats> {
  return statsForRange(dayRange(date, untilClock));
}

/** Running total for the month containing `date`, from the 1st up to the same
 *  cut-off as the daily figure. One request on the session path — the month is just
 *  a wider window on the same endpoint, not N day-queries summed. */
export async function getMonthToDateStats(
  date: string = vnDate(),
  untilClock?: string
): Promise<SalesStats> {
  return statsForRange(monthToDateRange(date, untilClock));
}

async function statsForRange(range: Range): Promise<SalesStats> {
  const sessionToken = await getSessionToken();
  if (sessionToken) {
    try {
      return await statsFromSession(sessionToken, range);
    } catch (e) {
      // A cached token can be dead before its `exp` — logging out elsewhere kills the
      // session server-side. Drop it and log in once more before giving up.
      const canRelogin = Boolean(process.env.KIOTVIET_USERNAME && process.env.KIOTVIET_PASSWORD);
      if (!(e instanceof KiotAuthError) || !canRelogin) throw e;

      console.warn("[kiotviet] session token rejected; re-logging in");
      await getRedis()?.del(SESSION_KEY);
      const retry = await getSessionToken();
      if (!retry) throw e;
      return statsFromSession(retry, range);
    }
  }

  throw new KiotAuthError(
    "Chưa cấu hình KiotViet: cần KIOTVIET_USERNAME/PASSWORD hoặc KIOTVIET_SESSION_TOKEN."
  );
}

/** "2.069.000đ" */
export function formatVnd(amount: number): string {
  return `${amount.toLocaleString("vi-VN")}đ`;
}

/** "31/07/2026" from "2026-07-31" */
export function formatVnDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}
