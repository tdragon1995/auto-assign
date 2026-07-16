import { NextRequest, NextResponse } from "next/server";
import { validateDriverLogin } from "@/lib/driver-app";
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
// Validates the driver's credentials against the Cartrack Driver App backend, then
// bridges the login identity to the FLEET driver_id (the id used in smart_driver_id
// and for assignment). The Driver-App login returns its OWN driverID namespace,
// which does NOT equal the fleet delivery_driver_id — so we resolve the fleet id by
// the stable DC/PT employee code carried in both the login name and the fleet roster.
// Returns identity only; never the serverHash/session token. The PIN is read from
// the body, forwarded once, and never logged or stored.

/** Extract the payroll employee code (e.g. "DC101166") from a driver name. */
function empCode(name: string): string | null {
  const m = name.match(/(?:PT|DC)\s*\d+/i);
  return m ? m[0].replace(/\s+/g, "").toUpperCase() : null;
}

/** Strip the leading payroll prefix → just the human name, lowered. */
function cleanKey(name: string): string {
  return name.replace(/^.*?(?:PT|DC)\d+\s+/i, "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Resolve a Driver-App login name to the fleet {driver_id, driver_name}. Matches
 *  on the DC/PT code first (reliable, unique), then falls back to the clean name. */
async function resolveFleetDriver(
  loginName: string,
  env: Env
): Promise<{ driver_id: string; driver_name: string } | null> {
  const drivers = await getDrivers(env);
  const fullName = (d: { first_name?: string | null; last_name?: string | null }) =>
    `${d.first_name ?? ""} ${d.last_name ?? ""}`.trim();

  const code = empCode(loginName);
  if (code) {
    for (const d of drivers) {
      if (fullName(d).toUpperCase().replace(/\s+/g, "").includes(code)) {
        return { driver_id: d.delivery_driver_id, driver_name: fullName(d) };
      }
    }
  }
  const target = cleanKey(loginName);
  if (target) {
    for (const d of drivers) {
      if (cleanKey(fullName(d)) === target) {
        return { driver_id: d.delivery_driver_id, driver_name: fullName(d) };
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
    const result = await validateDriverLogin(phone, pin);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 401 });
    }

    // Bridge login identity → fleet driver_id (used for jobs + assignment).
    const fleet = await resolveFleetDriver(result.driverName ?? "", env);
    if (!fleet) {
      console.warn("[driver-auth] no fleet roster match for authenticated driver");
    }

    const driverId = fleet?.driver_id ?? result.driverID ?? "";
    const driverName = fleet?.driver_name ?? result.driverName ?? "";

    // Bind the session to this driver server-side. The job endpoints read the
    // driver_id from this signed cookie, never from client input — so a driver
    // can only ever act as themselves. We return the name for display only.
    const resp = NextResponse.json({
      ok: true,
      driver_name: driverName,
      fleet_matched: !!fleet,
      is_active_delivery_driver: result.isActiveDeliveryDriver,
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
