/**
 * Signed session for the driver self-claim ("Nhận Việc") flow.
 *
 * The job endpoints MUST NOT trust a client-supplied driver_id — otherwise a
 * driver could act on another driver's behalf (view/claim their jobs) just by
 * passing a different id. Instead, on a successful phone+PIN login we mint an
 * HMAC-signed token carrying the authenticated fleet driver_id, set it as an
 * HttpOnly cookie, and derive the driver_id from that token on every job call.
 * The signature means a client cannot forge a session for someone else, and the
 * HttpOnly flag keeps JS from reading or tampering with it.
 */
import crypto from "crypto";

export const NV_COOKIE = "nv_session";
const TTL_MS = 12 * 60 * 60 * 1000; // 12h — a working day plus margin
export const NV_COOKIE_MAX_AGE = TTL_MS / 1000;

/** HMAC key. Dedicated secret preferred; falls back to the always-present
 *  CARTRACK_WEB_PASS so the flow is signed even without extra config. */
function secret(): string {
  const s = process.env.DRIVER_SESSION_SECRET || process.env.CARTRACK_WEB_PASS || "";
  if (!s) console.warn("[driver-session] no DRIVER_SESSION_SECRET/CARTRACK_WEB_PASS — sessions are unsigned");
  return s;
}

interface SessionPayload {
  driver_id: string;
  driver_name: string;
  exp: number;
}

function hmac(body: string): string {
  return crypto.createHmac("sha256", secret()).update(body).digest("base64url");
}

export function signSession(driverId: string, driverName: string): string {
  const payload: SessionPayload = { driver_id: driverId, driver_name: driverName, exp: Date.now() + TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(body)}`;
}

/** Verify + decode a session token. Returns null on any tampering, bad signature,
 *  or expiry — callers treat null as "not authenticated". */
export function verifySession(token: string | undefined | null): { driver_id: string; driver_name: string } | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = hmac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (typeof p.exp !== "number" || Date.now() > p.exp || !p.driver_id) return null;
    return { driver_id: p.driver_id, driver_name: p.driver_name ?? "" };
  } catch {
    return null;
  }
}
