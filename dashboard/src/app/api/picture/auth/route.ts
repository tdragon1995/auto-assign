import { NextRequest, NextResponse } from "next/server";
import { labcenterSignIn } from "@/lib/labcenter";
import { PR_COOKIE, PR_COOKIE_MAX_AGE, PR_COOKIE_OPTS, signReviewSession } from "@/lib/review-session";

export const runtime = "nodejs";
export const preferredRegion = "sin1";

// POST /api/picture/auth — { email, password }
//   Authenticates the reviewer against Labcenter (the one account every Diag staff
//   member already has) and mints the signed cookie every verdict is stamped with.
//   The password is forwarded once and never stored or logged.
export async function POST(req: NextRequest) {
  let email = "";
  let password = "";
  try {
    const body = await req.json();
    email = String(body?.email ?? "").trim().toLowerCase();
    password = String(body?.password ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "Yêu cầu không hợp lệ." }, { status: 400 });
  }
  if (!email || !password) {
    return NextResponse.json({ ok: false, error: "Nhập email và mật khẩu." }, { status: 400 });
  }

  try {
    if (!(await labcenterSignIn(email, password))) {
      return NextResponse.json({ ok: false, error: "Email hoặc mật khẩu không đúng." }, { status: 401 });
    }
  } catch (e) {
    console.error("[picture/auth] transport error:", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, error: "Không kết nối được Labcenter." }, { status: 502 });
  }

  const resp = NextResponse.json({ ok: true, email });
  resp.cookies.set(PR_COOKIE, signReviewSession(email), { ...PR_COOKIE_OPTS, maxAge: PR_COOKIE_MAX_AGE });
  return resp;
}

// DELETE /api/picture/auth — log out.
export async function DELETE() {
  const resp = NextResponse.json({ ok: true });
  resp.cookies.set(PR_COOKIE, "", { ...PR_COOKIE_OPTS, maxAge: 0 });
  return resp;
}
