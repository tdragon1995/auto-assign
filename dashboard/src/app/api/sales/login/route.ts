import { NextRequest, NextResponse } from "next/server";
import { verifyLabcenterUser } from "@/lib/labcenter";
import { SALES_COOKIE, SALES_COOKIE_MAX_AGE, salesUser, signSalesSession } from "@/lib/sales-session";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
};

// GET — who is signed in (null = show the login form)
export async function GET(req: NextRequest) {
  return NextResponse.json({ user: salesUser(req) });
}

// POST { email, password } — checked against Labcenter, never stored
export async function POST(req: NextRequest) {
  const { email, password } = await req.json().catch(() => ({}));
  if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
    return NextResponse.json({ error: "Nhập email và mật khẩu Labcenter" }, { status: 400 });
  }
  try {
    const user = await verifyLabcenterUser(email.trim(), password);
    if (!user) return NextResponse.json({ error: "Sai email hoặc mật khẩu Labcenter" }, { status: 401 });
    const resp = NextResponse.json({ user });
    resp.cookies.set(SALES_COOKIE, signSalesSession(user), { ...COOKIE_OPTS, maxAge: SALES_COOKIE_MAX_AGE });
    return resp;
  } catch {
    return NextResponse.json({ error: "Không kết nối được Labcenter, thử lại sau" }, { status: 502 });
  }
}

// DELETE — sign out
export async function DELETE() {
  const resp = NextResponse.json({ ok: true });
  resp.cookies.set(SALES_COOKIE, "", { ...COOKIE_OPTS, maxAge: 0 });
  return resp;
}
