import { Redis } from "@upstash/redis";
import { vnDate, addDays } from "./time";

// ── KiotViet sales stats (revenue + order count) ─────────────────────────────
// Two auth paths, tried in order. They exist because KiotViet's SSO does NOT
// support the password grant — `grant_types_supported` on
// id.kiotviet.vn/.well-known/openid-configuration lists only authorization_code,
// client_credentials, refresh_token, implicit and device_code. So a bot cannot
// log in as a human with a username/password; it needs either its own
// machine-to-machine client, or a session token copied out of a browser.
//
//   1. "public"  — client_credentials against the SSO → Public API. Self-renewing,
//                  no manual upkeep. Needs Public API switched on in KiotViet admin.
//   2. "session" — the 28-day browser session JWT pasted into an env var. Works
//                  immediately but goes stale; the bot says so instead of dying quietly.

const SSO_TOKEN_URL = "https://id.kiotviet.vn/connect/token";
const PUBLIC_API_URL = "https://public.kiotapi.com";
const INTERNAL_API_URL = "https://api-man1.kiotviet.vn";

// Cached client_credentials token. Keyed by nothing else — one bot, one client.
const TOKEN_KEY = "kiot:access_token";

const RETAILER = process.env.KIOTVIET_RETAILER ?? "nhathuocdiag";
const BRANCH_ID = Number(process.env.KIOTVIET_BRANCH_ID ?? 95562);
const GROUP_ID = process.env.KIOTVIET_GROUP_ID ?? "45";

// Invoice statuses that count as real sales: 1 = Hoàn thành, 3 = Đang xử lý.
// 2 (Đã hủy / cancelled) is excluded, mirroring the KiotViet dashboard's own filter.
const COUNTED_STATUSES = [1, 3];

function getRedis() {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export type AuthMode = "public" | "session";

export interface SalesStats {
  date: string;        // YYYY-MM-DD (VN date)
  revenue: number;     // đồng
  orders: number;      // invoice count
  source: AuthMode;
}

/** Mint (or reuse) a Public API token via client_credentials. Null when the
 *  Public API client isn't configured — caller falls back to the session token. */
async function getPublicToken(): Promise<string | null> {
  const clientId = process.env.KIOTVIET_CLIENT_ID;
  const clientSecret = process.env.KIOTVIET_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const redis = getRedis();
  if (redis) {
    const cached = await redis.get<string>(TOKEN_KEY);
    if (cached) return cached;
  }

  const res = await fetch(SSO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    // KiotViet's documented param is `scopes` (plural) — not the OAuth-standard `scope`.
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scopes: "PublicApi.Access",
    }),
  });

  if (!res.ok) {
    console.error("[kiotviet] client_credentials failed", res.status, await res.text().catch(() => ""));
    return null;
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;

  if (redis && json.expires_in && json.expires_in > 120) {
    // Expire a minute early so we never hand out a token mid-flight.
    await redis.set(TOKEN_KEY, json.access_token, { ex: json.expires_in - 60 });
  }
  return json.access_token;
}

/** Sales stats via the official Public API. Paginates the invoice list and
 *  aggregates client-side — the Public API has no dashboard-summary endpoint. */
async function statsFromPublicApi(token: string, date: string): Promise<SalesStats> {
  const headers = {
    Retailer: RETAILER,
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  let revenue = 0;
  let orders = 0;
  let currentItem = 0;
  const pageSize = 100;

  // Bounded loop: 50 pages × 100 = 5000 invoices/day is far past this branch's volume,
  // and stops a malformed `total` from spinning the request forever.
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({
      branchIds: String(BRANCH_ID),
      fromPurchaseDate: `${date} 00:00:00`,
      toPurchaseDate: `${date} 23:59:59`,
      pageSize: String(pageSize),
      currentItem: String(currentItem),
    });

    const res = await fetch(`${PUBLIC_API_URL}/invoices?${qs}`, { headers });
    if (!res.ok) {
      throw new Error(`KiotViet Public API ${res.status}: ${await res.text().catch(() => "")}`);
    }

    const json = (await res.json()) as {
      total?: number;
      data?: Array<{ total?: number; status?: number }>;
    };
    const rows = json.data ?? [];

    for (const inv of rows) {
      if (!COUNTED_STATUSES.includes(inv.status ?? 0)) continue;
      revenue += inv.total ?? 0;
      orders += 1;
    }

    currentItem += rows.length;
    if (rows.length < pageSize || currentItem >= (json.total ?? 0)) break;
  }

  return { date, revenue, orders, source: "public" };
}

/** Sales stats via the internal dashboard endpoint the KiotViet web UI itself calls.
 *  One request, server-side aggregates already computed. Requires a session JWT. */
async function statsFromSession(token: string, date: string): Promise<SalesStats> {
  const next = addDays(date, 1);
  const filter =
    `(BranchId eq ${BRANCH_ID} and (Status eq 1 or Status eq 3) and ` +
    `(PurchaseDate ge datetime'${date}T00:00:00' and PurchaseDate lt datetime'${next}T00:00:00'))`;

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
    date,
    revenue: json.Total1Value ?? 0,
    orders: json.Total ?? 0,
    source: "session",
  };
}

/** Raised when KiotViet credentials are missing or stale — the bot surfaces this
 *  verbatim so a dead token is visible in chat rather than silently returning 0đ. */
export class KiotAuthError extends Error {}

/** Revenue + order count for a VN date (defaults to today). */
export async function getSalesStats(date: string = vnDate()): Promise<SalesStats> {
  const publicToken = await getPublicToken();
  if (publicToken) return statsFromPublicApi(publicToken, date);

  const sessionToken = process.env.KIOTVIET_SESSION_TOKEN;
  if (sessionToken) return statsFromSession(sessionToken, date);

  throw new KiotAuthError(
    "Chưa cấu hình KiotViet: cần KIOTVIET_CLIENT_ID/SECRET hoặc KIOTVIET_SESSION_TOKEN."
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
