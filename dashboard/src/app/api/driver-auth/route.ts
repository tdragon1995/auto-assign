import { NextRequest, NextResponse } from "next/server";
import { validateDriverIdentityOnly } from "@/lib/driver-app";
import { getDrivers, type Env } from "@/lib/cartrack";
import { signSession, NV_COOKIE, NV_COOKIE_MAX_AGE } from "@/lib/driver-session";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  // Secure only in prod — a Secure cookie won't be set over http://localhost in dev.
  secure: process.env.NODE_ENV === "production",
};

// ── POST /api/driver-auth?env=prod ───────────────────────────────────────────
// Body: { phone: string, pin: string }
// Validates the driver's credentials against the Cartrack Driver App backend
// WITHOUT completing the errorCode-169 concurrent-session challenge — so it never
// takes over (and logs out) the driver's phone app. Identity is then bridged to
// the FLEET driver_id (the id used in smart_driver_id + assignment) by matching
// the entered phone number against the fleet roster; on a full-success login we
// also have the name as a fallback. The Driver-App driverID is a different id
// space and is NOT used. Never logs/stores the PIN or any session token.

/** Extract the payroll employee code (e.g. "DC101166") from a driver name. */
function empCode(name: string): string | null {
  const m = name.match(/(?:PT|DC)\s*\d+/i);
  return m ? m[0].replace(/\s+/g, "").toUpperCase() : null;
}

/** Strip the leading payroll prefix → just the human name, lowered. */
function cleanKey(name: string): string {
  return name.replace(/^.*?(?:PT|DC)\d+\s+/i, "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Last 9 digits (the VN mobile core), so "+84949…", "0949…", "84949…" all match. */
function normPhone(p: string): string {
  const d = (p || "").replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-9) : d;
}

const fullName = (d: { first_name?: string | null; last_name?: string | null }) =>
  `${d.first_name ?? ""} ${d.last_name ?? ""}`.trim();

/** Resolve the fleet {driver_id, driver_name} for an authenticated driver. Matches
 *  the entered PHONE against the roster first (works even when the 169 challenge
 *  leaves us with no login name), then falls back to the DC/PT code / clean name. */
async function resolveFleetDriver(
  phone: string,
  loginName: string | null,
  env: Env
): Promise<{ driver_id: string; driver_name: string } | null> {
  const drivers = await getDrivers(env);

  const target = normPhone(phone);
  if (target) {
    for (const d of drivers) {
      if (d.phone_number && normPhone(d.phone_number) === target) {
        return { driver_id: d.delivery_driver_id, driver_name: fullName(d) };
      }
    }
  }

  if (loginName) {
    const code = empCode(loginName);
    if (code) {
      for (const d of drivers) {
        if (fullName(d).toUpperCase().replace(/\s+/g, "").includes(code)) {
          return { driver_id: d.delivery_driver_id, driver_name: fullName(d) };
        }
      }
    }
    const clean = cleanKey(loginName);
    if (clean) {
      for (const d of drivers) {
        if (cleanKey(fullName(d)) === clean) {
          return { driver_id: d.delivery_driver_id, driver_name: fullName(d) };
        }
      }
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  const env = (req.nextUrl.searchParams.get("env") ?? "prod") as Env;

  let phone = "";
  let pin = "";
  try {
    const body = await req.json();
    phone = String(body?.phone ?? "").trim();
    pin = String(body?.pin ?? "").trim();
  } catch {
    return NextResponse.json({ ok: false, error: "Yêu cầu không hợp lệ." }, { status: 400 });
  }

  if (!phone || !pin) {
    return NextResponse.json(
      { ok: false, error: "Vui lòng nhập số điện thoại và mã PIN." },
      { status: 400 }
    );
  }

  try {
    // Stage-1 only: does NOT complete the 169 challenge, so the phone stays logged in.
    const result = await validateDriverIdentityOnly(phone, pin);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error ?? "Số điện thoại hoặc mã PIN không đúng." },
        { status: 401 }
      );
    }

    // Bridge to the fleet driver_id (by phone, then name). Required — without it we
    // have no id to bind the session to, so reject rather than guess.
    const fleet = await resolveFleetDriver(phone, result.driverName, env);
    if (!fleet) {
      console.warn("[driver-auth] no fleet roster match for authenticated driver");
      return NextResponse.json(
        { ok: false, error: "Không tìm thấy hồ sơ tài xế khớp số điện thoại. Liên hệ điều phối." },
        { status: 422 }
      );
    }

    const driverId = fleet.driver_id;
    const driverName = fleet.driver_name;

    // Bind the session to this driver server-side. The job endpoints read the
    // driver_id from this signed cookie, never from client input — so a driver
    // can only ever act as themselves. We return the name for display only.
    const resp = NextResponse.json({
      ok: true,
      driver_name: driverName,
      fleet_matched: true,
    });
    resp.cookies.set(NV_COOKIE, signSession(driverId, driverName), {
      ...COOKIE_OPTS,
      maxAge: NV_COOKIE_MAX_AGE,
    });
    return resp;
  } catch (e) {
    console.error("[driver-auth] transport error:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { ok: false, error: "Không kết nối được máy chủ Cartrack. Vui lòng thử lại." },
      { status: 502 }
    );
  }
}

// ── DELETE /api/driver-auth — log out (clear the session cookie) ─────────────
export async function DELETE() {
  const resp = NextResponse.json({ ok: true });
  resp.cookies.set(NV_COOKIE, "", { ...COOKIE_OPTS, maxAge: 0 });
  return resp;
}
