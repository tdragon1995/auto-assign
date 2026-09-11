import { NextRequest, NextResponse } from "next/server";
import { sendResendEmail } from "@/lib/disarm-alert";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}` || req.headers.get("x-cron-secret") === secret;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.subject !== "string" || typeof body.html !== "string") return NextResponse.json({ error: "subject and html are required" }, { status: 400 });
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "email transport not configured" }, { status: 503 });
  const to = process.env.ALERT_EMAIL_TO || "long.nguyen@diag.vn";
  const from = process.env.ALERT_EMAIL_FROM || "Fleet Auto-Assign <onboarding@resend.dev>";
  await sendResendEmail(apiKey, { to, from, subject: body.subject, html: body.html });
  return NextResponse.json({ ok: true });
}
