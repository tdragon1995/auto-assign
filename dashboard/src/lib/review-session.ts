/**
 * Signed session for the photo-review screen (/picture).
 *
 * Same shape and same reasoning as driver-session.ts: the reviewer's email is the
 * audit trail, so it must not be client-supplied — otherwise every verdict is
 * attributable to whoever the browser felt like claiming to be. The email is put in
 * an HMAC-signed HttpOnly cookie at login and read from there on every write.
 *
 * Kept separate from driver-session rather than generalised: that module carries a
 * driver's identity into the job endpoints, and widening a working auth path to take
 * an arbitrary payload is the kind of change that goes wrong quietly.
 */
import crypto from "crypto";

export const PR_COOKIE = "pr_session";
const TTL_MS = 12 * 60 * 60 * 1000; // one working day
export const PR_COOKIE_MAX_AGE = TTL_MS / 1000;

export const PR_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
};

function secret(): string {
  const s = process.env.DRIVER_SESSION_SECRET || process.env.CARTRACK_WEB_PASS || "";
  if (!s) console.warn("[review-session] no DRIVER_SESSION_SECRET/CARTRACK_WEB_PASS — sessions are unsigned");
  return s;
}

function hmac(body: string): string {
  return crypto.createHmac("sha256", secret()).update(body).digest("base64url");
}

export function signReviewSession(email: string): string {
  const body = Buffer.from(JSON.stringify({ email, exp: Date.now() + TTL_MS })).toString("base64url");
  return `${body}.${hmac(body)}`;
}

/** The authenticated reviewer's email, or null on any tampering, bad signature or expiry. */
export function reviewerEmail(token: string | undefined | null): string | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(hmac(token.slice(0, dot)));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(token.slice(0, dot), "base64url").toString());
    if (typeof p?.exp !== "number" || Date.now() > p.exp || !p?.email) return null;
    return String(p.email);
  } catch {
    return null;
  }
}
